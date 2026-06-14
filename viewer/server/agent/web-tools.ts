// server/agent/web-tools.ts — zero-dependency web access for the agent's
// web_search / web_fetch tools.
//
// Security model: the server runs on the user's machine, so the agent must
// never be able to point these tools at the user's own network. Two layers:
//  1. guardPublicUrl (per URL, per redirect hop): http/https only, no
//     loopback/private/link-local hosts, hostnames DNS-resolved and every
//     address checked — fast, friendly errors.
//  2. The default transport (pinnedFetch, node:http/https with a guarded
//     `lookup`) re-validates every address at CONNECT time, so DNS rebinding
//     between check and fetch cannot reach a private address (TOCTOU closed;
//     native fetch exposes no lookup hook, hence the hand-rolled client).
//
// Trust-boundary exceptions (both USER-configured, never model-controlled):
//  - proxyUrl: all traffic tunnels through the user's proxy, which resolves
//    target DNS itself — local DNS pinning is skipped (it may be unavailable
//    or poisoned in proxied environments); hostname/IP-literal checks remain.
//  - searxngBaseUrl: a self-hosted SearXNG often lives on the LAN; requests
//    to the user-configured base run with allowPrivate.
//
// web_search is pluggable: Tavily / Brave / SearXNG (configured in the Config
// tab, stored in local.config.json `Web`) with DuckDuckGo as the zero-key
// default and automatic fallback. All backends are best-effort: an upstream
// failure degrades into a clear tool error (or a DDG fallback), never a crash.

import { lookup } from 'node:dns/promises';
import { lookup as dnsLookupCb } from 'node:dns';
import { isIP } from 'node:net';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { Readable } from 'node:stream';

export const WEB_TEXT_CAP = 15_000;
const MAX_REDIRECTS = 4;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1_500_000;
const SEARCH_RESULT_CAP = 8;
/** Per-result snippet cap — Tavily "content" can run to thousands of chars. */
const SNIPPET_CAP = 400;

export type FetchFn = typeof globalThis.fetch;
export type LookupFn = (hostname: string, opts: { all: true }) => Promise<Array<{ address: string }>>;

/** Search/proxy settings from local.config.json `Web` — user-configured, server-side only. */
export interface WebSearchConfig {
  backend?: 'auto' | 'duckduckgo' | 'tavily' | 'brave' | 'searxng';
  tavilyApiKey?: string;
  braveApiKey?: string;
  searxngBaseUrl?: string;
  /** http:// CONNECT proxy (e.g. a local Clash/V2Ray port) for ALL web-tool traffic. */
  proxyUrl?: string;
}

export interface WebDeps {
  fetchFn?: FetchFn;
  lookupFn?: LookupFn;
  /** External cancellation (user pressed stop) — aborts the in-flight fetch. */
  signal?: AbortSignal;
  /** Backend/proxy settings (read fresh per request by the http layer). */
  config?: WebSearchConfig;
}

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const o = ip.split('.').map(Number);
    return (
      o[0] === 0 || o[0] === 10 || o[0] === 127 ||
      (o[0] === 100 && o[1] >= 64 && o[1] <= 127) || // CGNAT
      (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
      (o[0] === 192 && o[1] === 168) ||
      (o[0] === 169 && o[1] === 254)                 // link-local / cloud metadata
    );
  }
  const low = ip.toLowerCase();
  if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7)); // v4-mapped
  return (
    low === '::' || low === '::1' ||
    low.startsWith('fe80') ||                        // link-local
    low.startsWith('fc') || low.startsWith('fd')     // unique-local
  );
}

export interface GuardOpts {
  /**
   * Skip the local DNS-resolution step (hostname/IP-literal checks remain).
   * Used when a user-configured proxy carries the traffic: the proxy resolves
   * the target itself, and local DNS may be unavailable or poisoned.
   */
  skipDnsResolve?: boolean;
  /**
   * Allow private/loopback targets entirely (protocol check remains). ONLY for
   * URLs derived from user configuration (e.g. a LAN SearXNG base) — never for
   * model-chosen URLs.
   */
  allowPrivate?: boolean;
}

/** Returns an error string when the URL must not be fetched, null when OK. */
export async function guardPublicUrl(raw: string, lookupFn?: LookupFn, opts?: GuardOpts): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `invalid URL: ${raw}`;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `only http/https URLs are allowed (got ${u.protocol})`;
  }
  if (opts?.allowPrivate) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return 'loopback/private hosts are blocked';
  }
  if (isIP(host)) {
    return isPrivateIp(host) ? 'loopback/private addresses are blocked' : null;
  }
  // Cloud instance-metadata hostnames are blocked even when DNS resolution is
  // skipped (proxy-routed): a model-crafted fetch to one of these could otherwise
  // reach the VPS's metadata service via the proxy and steal cloud credentials.
  // (The numeric 169.254.169.254 form is already caught above as a private IP.)
  if (host === 'metadata' || host === 'metadata.google.internal' || host === 'metadata.goog' || host === 'instance-data') {
    return 'cloud metadata endpoints are blocked';
  }
  if (opts?.skipDnsResolve) return null;
  const doLookup = lookupFn ?? (lookup as unknown as LookupFn);
  let addrs: Array<{ address: string }>;
  try {
    addrs = await doLookup(host, { all: true });
  } catch {
    return `DNS resolution failed for ${host}`;
  }
  if (addrs.length === 0) return `DNS resolution failed for ${host}`;
  for (const a of addrs) {
    if (isPrivateIp(a.address)) return 'loopback/private addresses are blocked';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pinned default transport (TOCTOU-safe)
// ---------------------------------------------------------------------------

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void;

/**
 * dns.lookup wrapper handed to http(s).request: resolves with the caller's
 * options, then validates EVERY address before the socket may use it. This is
 * the connect-time enforcement — a hostname that re-resolves to a private
 * address after guardPublicUrl passed (DNS rebinding) fails right here.
 * Exported for tests.
 */
export function guardedLookup(hostname: string, options: Record<string, unknown> | LookupCallback, callback?: LookupCallback): void {
  const opts = (typeof options === 'function' ? {} : options) as Record<string, unknown>;
  const cb = (typeof options === 'function' ? options : callback) as LookupCallback;
  dnsLookupCb(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = addresses as Array<{ address: string; family: number }>;
    if (!Array.isArray(list) || list.length === 0) {
      return cb(Object.assign(new Error(`DNS resolution failed for ${hostname}`), { code: 'ENOTFOUND' }));
    }
    for (const a of list) {
      if (isPrivateIp(a.address)) {
        return cb(Object.assign(new Error('loopback/private addresses are blocked'), { code: 'EBLOCKED' }));
      }
    }
    if (opts.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

// Shape a node IncomingMessage into the minimal Response surface fetchPublic
// uses: status, headers.get, body as a web ReadableStream.
function toFetchResponse(res: IncomingMessage): Response {
  return {
    ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
    status: res.statusCode ?? 0,
    headers: {
      get: (name: string) => {
        const v = res.headers[name.toLowerCase()];
        return Array.isArray(v) ? v.join(', ') : v ?? null;
      },
    },
    body: Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>,
  } as unknown as Response;
}

// Minimal fetch-shaped client over node:http(s) so we can inject the guarded
// lookup (global fetch has no such hook). Never follows redirects.
function makeNodeFetch(guardLookup: boolean): FetchFn {
  return ((input: string | URL, init?: RequestInit): Promise<Response> => {
    return new Promise((resolvePromise, rejectPromise) => {
      const u = new URL(String(input));
      const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
        u,
        {
          method: init?.method ?? 'GET',
          headers: init?.headers as Record<string, string> | undefined,
          ...(guardLookup ? { lookup: guardedLookup as unknown as import('node:net').LookupFunction } : {}),
          signal: init?.signal ?? undefined,
        },
        (res) => resolvePromise(toFetchResponse(res)),
      );
      req.on('error', rejectPromise);
      if (init?.body) req.write(init.body);
      req.end();
    });
  }) as FetchFn;
}

/** Default transport: connect-time address validation (TOCTOU-safe). */
const pinnedFetch = makeNodeFetch(true);
/** allowPrivate transport — user-configured bases (LAN SearXNG) resolve freely. */
const plainFetch = makeNodeFetch(false);

/**
 * fetch-shaped client that tunnels through a USER-CONFIGURED http:// proxy
 * (e.g. a local Clash/V2Ray port — the proxy address itself may be loopback,
 * that is the point). http targets go as absolute-URI requests; https targets
 * via CONNECT + TLS over the tunnel. Target DNS resolves at the proxy, so the
 * guarded lookup does not apply here — guardPublicUrl's hostname checks still
 * ran before this is called (with skipDnsResolve).
 */
export function proxyFetch(proxyUrl: string): FetchFn {
  return ((input: string | URL, init?: RequestInit): Promise<Response> => {
    return new Promise((resolvePromise, rejectPromise) => {
      let proxy: URL;
      try {
        proxy = new URL(proxyUrl);
      } catch {
        rejectPromise(new Error(`invalid proxy URL: ${proxyUrl}`));
        return;
      }
      if (proxy.protocol !== 'http:') {
        rejectPromise(new Error('only http:// proxies are supported'));
        return;
      }
      const proxyPort = Number(proxy.port || 80);
      const target = new URL(String(input));
      const headers = init?.headers as Record<string, string> | undefined;

      if (target.protocol === 'http:') {
        // Plain http: absolute-URI request through the proxy.
        const req = httpRequest(
          {
            host: proxy.hostname,
            port: proxyPort,
            method: init?.method ?? 'GET',
            path: target.toString(),
            headers: { ...(headers ?? {}), host: target.host },
            signal: init?.signal ?? undefined,
          },
          (res) => resolvePromise(toFetchResponse(res)),
        );
        req.on('error', rejectPromise);
        if (init?.body) req.write(init.body);
        req.end();
        return;
      }

      // https: CONNECT tunnel, then TLS over the established socket.
      const targetPort = Number(target.port || 443);
      const connectReq = httpRequest({
        host: proxy.hostname,
        port: proxyPort,
        method: 'CONNECT',
        path: `${target.hostname}:${targetPort}`,
        signal: init?.signal ?? undefined,
      });
      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          rejectPromise(new Error(`proxy CONNECT failed: HTTP ${res.statusCode}`));
          return;
        }
        // Explicit TLS over the established tunnel — https.request would
        // otherwise open its own TCP connection (or send cleartext).
        const tlsSocket = tlsConnect({ socket, servername: target.hostname });
        tlsSocket.on('error', rejectPromise);
        const req = httpsRequest(
          {
            host: target.hostname,
            port: targetPort,
            method: init?.method ?? 'GET',
            path: target.pathname + target.search,
            headers,
            createConnection: () => tlsSocket,
            signal: init?.signal ?? undefined,
          },
          (res2) => resolvePromise(toFetchResponse(res2)),
        );
        req.on('error', rejectPromise);
        if (init?.body) req.write(init.body);
        req.end();
      });
      connectReq.on('error', rejectPromise);
      connectReq.end();
    });
  }) as FetchFn;
}

// ---------------------------------------------------------------------------
// Capped, redirect-checked fetch
// ---------------------------------------------------------------------------

export type FetchPublicResult =
  | { ok: true; finalUrl: string; status: number; contentType: string; body: string; truncatedBody: boolean }
  | { ok: false; error: string };

export interface FetchPublicOpts {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  /** See GuardOpts.allowPrivate — user-configured bases (SearXNG) only. */
  allowPrivate?: boolean;
}

export async function fetchPublic(rawUrl: string, deps: WebDeps = {}, opts: FetchPublicOpts = {}): Promise<FetchPublicResult> {
  // Default transport: the user's proxy when configured (it resolves target
  // DNS itself), else the pinned client (connect-time address validation) —
  // or the unpinned one for user-configured private bases, where the guarded
  // lookup would wrongly block a LAN hostname. Tests inject a plain fetchFn
  // and keep working unchanged.
  const viaProxy = !deps.fetchFn && !!deps.config?.proxyUrl;
  const fetchFn = deps.fetchFn
    ?? (viaProxy ? proxyFetch(deps.config!.proxyUrl!) : (opts.allowPrivate ? plainFetch : pinnedFetch));
  let url = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const guardErr = await guardPublicUrl(url, deps.lookupFn, {
      skipDnsResolve: viaProxy,
      allowPrivate: opts.allowPrivate,
    });
    if (guardErr) return { ok: false, error: guardErr };

    if (deps.signal?.aborted) return { ok: false, error: 'fetch cancelled' };
    const ctrl = new AbortController();
    const onOuterAbort = () => ctrl.abort();
    deps.signal?.addEventListener('abort', onOuterAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchFn(url, {
        method: opts.method ?? 'GET',
        body: opts.body,
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          'user-agent': 'ue-mat-workflow-agent/1.0 (+local material viewer)',
          accept: 'text/html,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          ...(opts.headers ?? {}),
        },
      });

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) return { ok: false, error: `redirect (${res.status}) without a Location header` };
        url = new URL(loc, url).toString();
        continue; // next hop re-runs the guard
      }

      const { body, truncated } = await readBodyCapped(res, MAX_BODY_BYTES);
      return {
        ok: true,
        finalUrl: url,
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        body,
        truncatedBody: truncated,
      };
    } catch (e) {
      const aborted = (e as Error)?.name === 'AbortError' || (e as NodeJS.ErrnoException)?.code === 'ABORT_ERR';
      const msg = aborted
        ? (deps.signal?.aborted ? 'cancelled' : `timed out after ${FETCH_TIMEOUT_MS / 1000}s`)
        : String((e as Error)?.message ?? e);
      return { ok: false, error: `fetch failed: ${msg}` };
    } finally {
      clearTimeout(timer);
      deps.signal?.removeEventListener('abort', onOuterAbort);
    }
  }
  return { ok: false, error: `too many redirects (>${MAX_REDIRECTS})` };
}

async function readBodyCapped(res: Response, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    return text.length > maxBytes
      ? { body: text.slice(0, maxBytes), truncated: true }
      : { body: text, truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  const buf = Buffer.concat(chunks.map(c => Buffer.from(c)));
  return { body: buf.subarray(0, maxBytes).toString('utf-8'), truncated };
}

// ---------------------------------------------------------------------------
// HTML → plain text (regex-based, zero deps — good enough for docs pages)
// ---------------------------------------------------------------------------

export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // Boilerplate blocks (site nav, footers, sidebars, embeds) are token noise
  // for the model \u2014 drop them wholesale. <header> is kept: article headers
  // often wrap the page title. Lazy match is a heuristic: nested same-name
  // tags lose the tail, which is acceptable for chrome regions.
  s = s.replace(/<(nav|footer|aside|form|svg|iframe)[\s\S]*?<\/\1>/gi, ' ');
  // Headings/list items become markdown-ish markers so structure survives.
  s = s.replace(/<h([1-6])[^>]*>/gi, (_, n: string) => `\n${'#'.repeat(Number(n))} `);
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  // Block-level closers become line breaks so structure survives the strip.
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre)>/gi, '\n');
  s = s.replace(/<(br|hr)\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function safeFromCodePoint(cp: number): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// DuckDuckGo HTML result parsing
// ---------------------------------------------------------------------------

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Parse html.duckduckgo.com/html results. Empty array = layout changed or no hits. */
export function parseDuckDuckGoHtml(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const anchorRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  for (let m = snippetRe.exec(html); m; m = snippetRe.exec(html)) {
    snippets.push(htmlToText(m[1]));
  }
  let i = 0;
  for (let m = anchorRe.exec(html); m && hits.length < SEARCH_RESULT_CAP; m = anchorRe.exec(html), i++) {
    const url = resolveDdgRedirect(decodeEntities(m[1]));
    if (!url) continue;
    hits.push({ title: htmlToText(m[2]), url, snippet: snippets[i] ?? '' });
  }
  return hits;
}

/** DDG html links are //duckduckgo.com/l/?uddg=<encoded-target>&rut=… — unwrap them. */
function resolveDdgRedirect(href: string): string | null {
  if (href.startsWith('//duckduckgo.com/l/') || href.startsWith('https://duckduckgo.com/l/')) {
    try {
      const u = new URL(href.startsWith('//') ? `https:${href}` : href);
      const target = u.searchParams.get('uddg');
      return target ? decodeURIComponent(target) : null;
    } catch {
      return null;
    }
  }
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  return null;
}

/**
 * Parse lite.duckduckgo.com/lite results (table layout: result-link anchors,
 * result-snippet cells). The fallback endpoint when the html one is blocked
 * or changes layout.
 */
export function parseDuckDuckGoLite(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const anchorRe = /class=['"]result-link['"][^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>|href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g;
  const snippets: string[] = [];
  for (let m = snippetRe.exec(html); m; m = snippetRe.exec(html)) {
    snippets.push(htmlToText(m[1]));
  }
  let i = 0;
  for (let m = anchorRe.exec(html); m && hits.length < SEARCH_RESULT_CAP; m = anchorRe.exec(html), i++) {
    const url = resolveDdgRedirect(decodeEntities(m[1] ?? m[3]));
    if (!url) continue;
    hits.push({ title: htmlToText(m[2] ?? m[4]), url, snippet: snippets[i] ?? '' });
  }
  return hits;
}

export type WebSearchResult =
  | { ok: true; backend: string; results: SearchHit[]; note?: string }
  | { ok: false; error: string };

const clip = (s: string): string => (s.length > SNIPPET_CAP ? `${s.slice(0, SNIPPET_CAP)}…` : s);

// DDG's html/lite endpoints bot-detect aggressively: a distinctive tool UA gets
// flagged after a couple of requests and every call then returns an HTTP 202
// challenge page. A mainstream browser UA raises that threshold considerably.
const DDG_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9,zh-TW;q=0.8',
};

const DDG_RATE_LIMITED =
  'DuckDuckGo 偵測到自動化流量，暫時拒絕服務（HTTP 202）。請過幾分鐘再試；' +
  '常用建議：到 Config → AI 助手配置 Tavily／Brave／SearXNG 搜尋後端，比 DDG 爬取穩定得多。';

async function searchDuckDuckGo(query: string, deps: WebDeps): Promise<WebSearchResult> {
  const r = await fetchPublic(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, deps, { headers: DDG_HEADERS });
  if (r.ok && r.status === 200) {
    const results = parseDuckDuckGoHtml(r.body);
    if (results.length > 0) return { ok: true, backend: 'duckduckgo', results };
  }
  // html endpoint failed / rate-limited / layout changed → try the lite endpoint.
  const r2 = await fetchPublic(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, deps, { headers: DDG_HEADERS });
  if (!r2.ok) return { ok: false, error: r.ok ? r2.error : `${(r as { error: string }).error}; lite fallback: ${r2.error}` };
  if (r2.status !== 200) {
    if (r2.status === 202 || (r.ok && r.status === 202)) return { ok: false, error: DDG_RATE_LIMITED };
    return { ok: false, error: `search endpoints returned HTTP ${r.ok ? r.status : '?'} / ${r2.status} — DuckDuckGo 可能暫時限流，稍後再試` };
  }
  const results = parseDuckDuckGoLite(r2.body);
  if (results.length === 0) {
    // A 200 challenge page also parses to zero results — distinguish the
    // anomaly page (the html endpoint already said 202) from a true no-hit.
    if (r.ok && r.status === 202) return { ok: false, error: DDG_RATE_LIMITED };
    return { ok: false, error: 'no results parsed — the query found nothing or the search page layout changed' };
  }
  return { ok: true, backend: 'duckduckgo-lite', results };
}

async function searchTavily(query: string, deps: WebDeps): Promise<WebSearchResult> {
  const key = deps.config?.tavilyApiKey;
  if (!key) return { ok: false, error: 'tavily: API key not configured（Config 分頁 → 網路搜尋）' };
  const r = await fetchPublic('https://api.tavily.com/search', deps, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    // api_key in the body keeps older API versions working alongside the Bearer header.
    body: JSON.stringify({ api_key: key, query, max_results: SEARCH_RESULT_CAP }),
  });
  if (!r.ok) return r;
  if (r.status !== 200) return { ok: false, error: `tavily returned HTTP ${r.status}: ${r.body.slice(0, 200)}` };
  try {
    const json = JSON.parse(r.body) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    const results = (json.results ?? [])
      .filter(x => typeof x.url === 'string')
      .slice(0, SEARCH_RESULT_CAP)
      .map(x => ({ title: x.title ?? '', url: x.url!, snippet: clip(x.content ?? '') }));
    if (results.length === 0) return { ok: false, error: 'tavily: no results' };
    return { ok: true, backend: 'tavily', results };
  } catch {
    return { ok: false, error: 'tavily: unparseable response' };
  }
}

async function searchBrave(query: string, deps: WebDeps): Promise<WebSearchResult> {
  const key = deps.config?.braveApiKey;
  if (!key) return { ok: false, error: 'brave: API key not configured（Config 分頁 → 網路搜尋）' };
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${SEARCH_RESULT_CAP}`;
  const r = await fetchPublic(url, deps, {
    headers: { accept: 'application/json', 'x-subscription-token': key },
  });
  if (!r.ok) return r;
  if (r.status !== 200) return { ok: false, error: `brave returned HTTP ${r.status}: ${r.body.slice(0, 200)}` };
  try {
    const json = JSON.parse(r.body) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
    const results = (json.web?.results ?? [])
      .filter(x => typeof x.url === 'string')
      .slice(0, SEARCH_RESULT_CAP)
      .map(x => ({ title: htmlToText(x.title ?? ''), url: x.url!, snippet: clip(htmlToText(x.description ?? '')) }));
    if (results.length === 0) return { ok: false, error: 'brave: no results' };
    return { ok: true, backend: 'brave', results };
  } catch {
    return { ok: false, error: 'brave: unparseable response' };
  }
}

async function searchSearxng(query: string, deps: WebDeps): Promise<WebSearchResult> {
  const base = deps.config?.searxngBaseUrl?.replace(/\/+$/, '');
  if (!base) return { ok: false, error: 'searxng: baseUrl not configured（Config 分頁 → 網路搜尋）' };
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
  // The base is user configuration — a self-hosted instance on the LAN is the
  // normal case, so the private-address guard is waived for this call.
  const r = await fetchPublic(url, deps, { allowPrivate: true });
  if (!r.ok) return r;
  if (r.status === 403) return { ok: false, error: 'searxng returned 403 — 該實例未開放 JSON API（settings.yml 需啟用 formats: json）' };
  if (r.status !== 200) return { ok: false, error: `searxng returned HTTP ${r.status}` };
  try {
    const json = JSON.parse(r.body) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    const results = (json.results ?? [])
      .filter(x => typeof x.url === 'string')
      .slice(0, SEARCH_RESULT_CAP)
      .map(x => ({ title: x.title ?? '', url: x.url!, snippet: clip(x.content ?? '') }));
    if (results.length === 0) return { ok: false, error: 'searxng: no results' };
    return { ok: true, backend: 'searxng', results };
  } catch {
    return { ok: false, error: 'searxng: unparseable response（實例需開啟 JSON 格式）' };
  }
}

/** 'auto' precedence: whichever key-based backend is configured wins; DDG is the zero-config floor. */
function resolveBackend(cfg: WebSearchConfig | undefined): 'duckduckgo' | 'tavily' | 'brave' | 'searxng' {
  if (cfg?.backend && cfg.backend !== 'auto') return cfg.backend;
  if (cfg?.tavilyApiKey) return 'tavily';
  if (cfg?.braveApiKey) return 'brave';
  if (cfg?.searxngBaseUrl) return 'searxng';
  return 'duckduckgo';
}

const BACKEND_FNS: Record<string, (q: string, d: WebDeps) => Promise<WebSearchResult>> = {
  duckduckgo: searchDuckDuckGo,
  tavily: searchTavily,
  brave: searchBrave,
  searxng: searchSearxng,
};

export async function webSearch(query: string, deps: WebDeps = {}): Promise<WebSearchResult> {
  const backend = resolveBackend(deps.config);
  const r = await BACKEND_FNS[backend](query, deps);
  if (r.ok || backend === 'duckduckgo') return r;
  // Configured backend failed (key revoked, quota, instance down…) — degrade
  // to the zero-key default instead of leaving the model searchless, and say so.
  const fb = await searchDuckDuckGo(query, deps);
  if (fb.ok) return { ...fb, note: `${backend} 後端失敗（${r.error}），本次已改用 DuckDuckGo` };
  return r; // the configured backend's error is the more actionable one
}
