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
  guardedLookup,
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

  it('blocks cloud-metadata hostnames even when DNS resolution is skipped (proxy path)', async () => {
    // .internal suffix already blocks the GCP form; the bare-label aliases reach
    // the dedicated metadata guard. Either way the fetch is refused.
    expect(await guardPublicUrl('http://metadata.google.internal/', undefined, { skipDnsResolve: true })).toMatch(/blocked/);
    expect(await guardPublicUrl('http://metadata/computeMetadata/v1/', undefined, { skipDnsResolve: true })).toMatch(/metadata/);
    expect(await guardPublicUrl('http://instance-data/latest/', undefined, { skipDnsResolve: true })).toMatch(/metadata/);
    // A normal public host with DNS skipped still passes (proxy resolves it).
    expect(await guardPublicUrl('https://example.com/', undefined, { skipDnsResolve: true })).toBeNull();
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

// ---------------------------------------------------------------------------
// BUG-8 — DNS-rebinding TOCTOU: the default transport validates every address
// at CONNECT time via guardedLookup, not only at guardPublicUrl time.
// ---------------------------------------------------------------------------

describe('guardedLookup (BUG-8)', () => {

  it('blocks a hostname that resolves to loopback (rebinding caught at connect time)', async () => {
    // localhost resolves locally without network access — deterministic.
    const err = await new Promise<Error | null>((res) => {
      guardedLookup('localhost', {}, (e) => res(e));
    });
    expect(err).not.toBeNull();
    expect(String(err?.message)).toContain('blocked');
  });

  it('surfaces resolution failures as errors', async () => {
    const err = await new Promise<Error | null>((res) => {
      guardedLookup('definitely-not-a-real-host.invalid', {}, (e) => res(e));
    });
    expect(err).not.toBeNull();
  });
});

describe('fetchPublic external cancellation', () => {
  it('an already-aborted deps.signal short-circuits before any fetch', async () => {
    const ac = new AbortController();
    ac.abort();
    let called = 0;
    const r = await fetchPublic('https://example.com/', {
      fetchFn: (async () => { called++; return new Response('x'); }) as unknown as typeof globalThis.fetch,
      lookupFn: async () => [{ address: '93.184.216.34' }],
      signal: ac.signal,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('cancelled');
    expect(called).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pluggable search backends (Tavily / Brave / SearXNG) + proxy + lite fallback
// ---------------------------------------------------------------------------

import { parseDuckDuckGoLite, proxyFetch, type WebSearchConfig } from '../server/agent/web-tools.js';
import { createServer } from 'node:http';

type Captured = { url?: string; init?: RequestInit };

function jsonFetch(payload: unknown, capture?: Captured): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (capture) { capture.url = String(url); capture.init = init; }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function routedFetch(routes: Array<[RegExp, () => Response]>): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    for (const [re, mk] of routes) if (re.test(String(url))) return mk();
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('guardPublicUrl opts', () => {
  it('skipDnsResolve keeps hostname/IP-literal checks but skips resolution', async () => {
    const failingLookup: LookupFn = async () => { throw new Error('no dns'); };
    expect(await guardPublicUrl('https://example.com/', failingLookup, { skipDnsResolve: true })).toBeNull();
    expect(await guardPublicUrl('http://127.0.0.1/', failingLookup, { skipDnsResolve: true })).toMatch(/blocked/);
    expect(await guardPublicUrl('http://localhost/', failingLookup, { skipDnsResolve: true })).toMatch(/blocked/);
  });

  it('allowPrivate waives host checks but never the protocol check', async () => {
    expect(await guardPublicUrl('http://192.168.1.10:8888/search', undefined, { allowPrivate: true })).toBeNull();
    expect(await guardPublicUrl('file:///etc/passwd', undefined, { allowPrivate: true })).toMatch(/only http\/https/);
  });
});

describe('htmlToText boilerplate + structure markers', () => {
  it('drops nav/footer/aside and keeps headings/list markers', () => {
    const html = `<nav><a href="/">Home</a> | <a href="/docs">Docs</a></nav>
      <h2>Roughness</h2><ul><li>low = shiny</li></ul>
      <footer>© 2026 Site footer junk</footer>`;
    const text = htmlToText(html);
    expect(text).not.toContain('Home');
    expect(text).not.toContain('footer junk');
    expect(text).toContain('## Roughness');
    expect(text).toContain('- low = shiny');
  });
});

const LITE_SAMPLE = `
<table>
  <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc" class='result-link'>Lite Doc Title</a></td></tr>
  <tr><td class='result-snippet'>Lite doc snippet text.</td></tr>
</table>`;

describe('DuckDuckGo lite fallback', () => {
  it('parseDuckDuckGoLite unwraps redirects and pairs snippets', () => {
    const hits = parseDuckDuckGoLite(LITE_SAMPLE);
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe('https://example.com/doc');
    expect(hits[0].title).toBe('Lite Doc Title');
    expect(hits[0].snippet).toContain('snippet text');
  });

  it('webSearch falls back to the lite endpoint when the html one is blocked', async () => {
    const fetchFn = routedFetch([
      [/html\.duckduckgo\.com/, () => new Response('rate limited', { status: 403 })],
      [/lite\.duckduckgo\.com/, () => new Response(LITE_SAMPLE, { status: 200 })],
    ]);
    const r = await webSearch('ue', { fetchFn, lookupFn: publicLookup });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.backend).toBe('duckduckgo-lite');
      expect(r.results[0].title).toBe('Lite Doc Title');
    }
  });
});

describe('search backends', () => {
  it('tavily: POSTs the query with the key and clips long snippets', async () => {
    const cap: Captured = {};
    const long = 'x'.repeat(600);
    const fetchFn = jsonFetch({ results: [{ title: 'T', url: 'https://e.com/a', content: long }] }, cap);
    const config: WebSearchConfig = { backend: 'tavily', tavilyApiKey: 'tvly-k' };
    const r = await webSearch('fresnel', { fetchFn, lookupFn: publicLookup, config });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.backend).toBe('tavily');
      expect(r.results[0].snippet.length).toBeLessThanOrEqual(401);
    }
    expect(cap.url).toContain('api.tavily.com');
    expect(cap.init?.method).toBe('POST');
    expect(String(cap.init?.body)).toContain('fresnel');
    expect((cap.init?.headers as Record<string, string>).authorization).toContain('tvly-k');
  });

  it('brave: GET with subscription token; description HTML is stripped', async () => {
    const cap: Captured = {};
    const fetchFn = jsonFetch({ web: { results: [{ title: 'B', url: 'https://e.com/b', description: '<strong>desc</strong> here' }] } }, cap);
    const config: WebSearchConfig = { backend: 'brave', braveApiKey: 'BSAkey' };
    const r = await webSearch('roughness', { fetchFn, lookupFn: publicLookup, config });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results[0].snippet).toBe('desc here');
    expect(cap.url).toContain('api.search.brave.com');
    expect((cap.init?.headers as Record<string, string>)['x-subscription-token']).toBe('BSAkey');
  });

  it('searxng: a private LAN base is allowed (user config, not model input)', async () => {
    const cap: Captured = {};
    const fetchFn = jsonFetch({ results: [{ title: 'S', url: 'https://e.com/s', content: 'c' }] }, cap);
    const config: WebSearchConfig = { backend: 'searxng', searxngBaseUrl: 'http://192.168.1.10:8888/' };
    const r = await webSearch('lerp', { fetchFn, lookupFn: privateLookup, config });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.backend).toBe('searxng');
    expect(cap.url).toBe('http://192.168.1.10:8888/search?q=lerp&format=json');
  });

  it('auto precedence: a configured tavily key wins over DDG', async () => {
    const fetchFn = jsonFetch({ results: [{ title: 'T', url: 'https://e.com', content: 'c' }] });
    const r = await webSearch('q', { fetchFn, lookupFn: publicLookup, config: { tavilyApiKey: 'k' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.backend).toBe('tavily');
  });

  it('failed configured backend falls back to DDG with an explanatory note', async () => {
    const fetchFn = routedFetch([
      [/api\.tavily\.com/, () => new Response('{"error":"quota"}', { status: 429 })],
      [/html\.duckduckgo\.com/, () => new Response(DDG_SAMPLE, { status: 200 })],
    ]);
    const r = await webSearch('q', { fetchFn, lookupFn: publicLookup, config: { backend: 'tavily', tavilyApiKey: 'k' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.backend).toBe('duckduckgo');
      expect(r.note).toContain('tavily');
    }
  });

  it('explicit backend without its key reports a config-pointing error after DDG also fails', async () => {
    const fetchFn = routedFetch([]); // everything 404s → DDG fallback fails too
    const r = await webSearch('q', { fetchFn, lookupFn: publicLookup, config: { backend: 'brave' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('not configured');
  });
});

describe('proxy transport', () => {
  it('routes http targets through the configured proxy as absolute-URI requests', async () => {
    const seen: { url?: string; host?: string } = {};
    const proxy = createServer((req, res) => {
      seen.url = req.url;
      seen.host = String(req.headers.host);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('PROXIED');
    });
    await new Promise<void>(r => proxy.listen(0, '127.0.0.1', () => r()));
    const port = (proxy.address() as { port: number }).port;
    try {
      const r = await fetchPublic('http://example.com/page', { config: { proxyUrl: `http://127.0.0.1:${port}` } });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.body).toBe('PROXIED');
      expect(seen.url).toBe('http://example.com/page');
      expect(seen.host).toBe('example.com');
    } finally {
      await new Promise(r => proxy.close(() => r(null)));
    }
  });

  it('proxy mode still blocks loopback/private targets at the URL level', async () => {
    const r = await fetchPublic('http://127.0.0.1:9999/secret', { config: { proxyUrl: 'http://127.0.0.1:1' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('blocked');
  });

  it('proxyFetch rejects non-http proxy URLs', async () => {
    await expect(proxyFetch('socks5://127.0.0.1:1080')('http://example.com/')).rejects.toThrow(/http:\/\//);
  });
});

describe('DDG bot-detection handling', () => {
  it('202 challenge on both endpoints yields the rate-limit guidance, with a browser UA sent', async () => {
    const uas: string[] = [];
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      uas.push((init?.headers as Record<string, string>)['user-agent'] ?? '');
      return new Response('challenge', { status: 202 });
    }) as typeof fetch;
    const r = await webSearch('q', { fetchFn, lookupFn: publicLookup });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('202');
      expect(r.error).toContain('Tavily');
    }
    expect(uas.every(ua => ua.startsWith('Mozilla/5.0'))).toBe(true);
  });
});
