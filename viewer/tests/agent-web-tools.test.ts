// agent-web-tools.test.ts — SSRF guard, capped fetch, HTML→text, and the
// DuckDuckGo result parser behind the web_search / web_fetch tools.
// All network access is injected; zero real requests.

import { describe, it, expect } from 'vitest';
import {
  isPrivateIp,
  guardPublicUrl,
  fetchPublic,
  htmlToText,
  decodeEntities,
  parseDuckDuckGoHtml,
  webSearch,
  type LookupFn,
} from '../server/agent/web-tools.js';

const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }];
const privateLookup: LookupFn = async () => [{ address: '192.168.1.10' }];
const mixedLookup: LookupFn = async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }];

describe('isPrivateIp', () => {
  it('flags loopback, RFC1918, link-local, CGNAT and v6 equivalents', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:192.168.1.1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });
  it('passes public addresses', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:2800:220:1::1', '::ffff:8.8.8.8']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
});

describe('guardPublicUrl', () => {
  it('rejects non-http schemes, localhost variants, and private IP literals', async () => {
    expect(await guardPublicUrl('file:///etc/passwd')).toMatch(/only http\/https/);
    expect(await guardPublicUrl('ftp://example.com/x')).toMatch(/only http\/https/);
    expect(await guardPublicUrl('not a url')).toMatch(/invalid URL/);
    expect(await guardPublicUrl('http://localhost:5790/api/crawl')).toMatch(/blocked/);
    expect(await guardPublicUrl('http://foo.localhost/')).toMatch(/blocked/);
    expect(await guardPublicUrl('http://nas.local/')).toMatch(/blocked/);
    expect(await guardPublicUrl('http://127.0.0.1:8080/')).toMatch(/blocked/);
    expect(await guardPublicUrl('http://192.168.1.1/admin')).toMatch(/blocked/);
    expect(await guardPublicUrl('http://169.254.169.254/latest/meta-data')).toMatch(/blocked/);
    expect(await guardPublicUrl('http://[::1]/')).toMatch(/blocked/);
  });

  it('DNS-resolves hostnames and blocks any private answer (rebinding shapes)', async () => {
    expect(await guardPublicUrl('https://example.com/', publicLookup)).toBeNull();
    expect(await guardPublicUrl('https://evil.example/', privateLookup)).toMatch(/blocked/);
    expect(await guardPublicUrl('https://evil.example/', mixedLookup)).toMatch(/blocked/);
    const failing: LookupFn = async () => { throw new Error('ENOTFOUND'); };
    expect(await guardPublicUrl('https://nope.example/', failing)).toMatch(/DNS resolution failed/);
  });
});

describe('fetchPublic', () => {
  it('follows redirects but re-guards every hop — a redirect into private space is blocked', async () => {
    const fetchFn = (async (url: RequestInfo | URL) => {
      if (String(url) === 'https://example.com/start') {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } });
      }
      throw new Error('should not fetch the redirect target');
    }) as typeof fetch;
    const r = await fetchPublic('https://example.com/start', { fetchFn, lookupFn: publicLookup });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/blocked/);
  });

  it('returns the final body + content type after a legal redirect', async () => {
    const fetchFn = (async (url: RequestInfo | URL) => {
      if (String(url) === 'https://example.com/a') {
        return new Response(null, { status: 301, headers: { location: 'https://example.com/b' } });
      }
      return new Response('<html><body><p>hello docs</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }) as typeof fetch;
    const r = await fetchPublic('https://example.com/a', { fetchFn, lookupFn: publicLookup });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.finalUrl).toBe('https://example.com/b');
      expect(r.contentType).toContain('text/html');
      expect(r.body).toContain('hello docs');
    }
  });

  it('surfaces fetch failures as errors, never throws', async () => {
    const fetchFn = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    const r = await fetchPublic('https://example.com/x', { fetchFn, lookupFn: publicLookup });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ECONNREFUSED/);
  });
});

describe('htmlToText / decodeEntities', () => {
  it('strips script/style, keeps block structure as newlines, decodes entities', () => {
    const html = `
      <html><head><style>p{color:red}</style><script>alert(1)</script></head>
      <body><h1>UE 5.7 Notes</h1><p>Fresnel &amp; &quot;rim&quot; light&nbsp;tips</p>
      <ul><li>step &lt;one&gt;</li><li>step #&#50;</li></ul></body></html>`;
    const text = htmlToText(html);
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
    expect(text).toContain('UE 5.7 Notes');
    expect(text).toContain('Fresnel & "rim" light tips');
    expect(text).toContain('step <one>');
    expect(text).toContain('step #2');
    expect(text).toMatch(/Notes\n/); // h1 closer became a line break
  });

  it('decodeEntities handles hex/dec code points safely', () => {
    expect(decodeEntities('&#x4e2d;&#x6587;')).toBe('中文');
    expect(decodeEntities('&#x110000;')).toBe(''); // out of Unicode range → dropped, no throw
  });
});

const DDG_SAMPLE = `
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdev.epicgames.com%2Fdocumentation%2Fen-us%2Funreal-engine%2Ffresnel&amp;rut=abc">Fresnel <b>Material</b> Node</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">How the Fresnel node shades surfaces by view angle.</a>
</div>
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="https://forums.unrealengine.com/t/rim-light/123">Rim light setup</a>
  <a class="result__snippet" href="#">Community thread about rim lighting.</a>
</div>`;

describe('parseDuckDuckGoHtml / webSearch', () => {
  it('unwraps the uddg redirect and pairs titles with snippets', () => {
    const hits = parseDuckDuckGoHtml(DDG_SAMPLE);
    expect(hits).toHaveLength(2);
    expect(hits[0].url).toBe('https://dev.epicgames.com/documentation/en-us/unreal-engine/fresnel');
    expect(hits[0].title).toBe('Fresnel Material Node');
    expect(hits[0].snippet).toContain('view angle');
    expect(hits[1].url).toBe('https://forums.unrealengine.com/t/rim-light/123');
  });

  it('webSearch returns parsed hits via the injected fetch, and a clear error on empty parses', async () => {
    const okFetch = (async () => new Response(DDG_SAMPLE, { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
    const r = await webSearch('ue fresnel', { fetchFn: okFetch, lookupFn: publicLookup });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results[0].title).toContain('Fresnel');

    const emptyFetch = (async () => new Response('<html>nothing here</html>', { status: 200 })) as typeof fetch;
    const r2 = await webSearch('xyz', { fetchFn: emptyFetch, lookupFn: publicLookup });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toMatch(/no results parsed/);
  });
});
