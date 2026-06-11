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
// web_search uses DuckDuckGo's HTML endpoint (no API key). It is best-effort:
// a layout change upstream degrades into a clear tool error, never a crash.

import { lookup } from 'node:dns/promises';
import { lookup as dnsLookupCb } from 'node:dns';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

export const WEB_TEXT_CAP = 15_000;
const MAX_REDIRECTS = 4;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1_500_000;
const SEARCH_RESULT_CAP = 8;

export type FetchFn = typeof globalThis.fetch;
export type LookupFn = (hostname: string, opts: { all: true }) => Promise<Array<{ address: string }>>;

export interface WebDeps {
  fetchFn?: FetchFn;
  lookupFn?: LookupFn;
  /** External cancellation (user pressed stop) — aborts the in-flight fetch. */
  signal?: AbortSignal;
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

/** Returns an error string when the URL must not be fetched, null when OK. */
export async function guardPublicUrl(raw: string, lookupFn?: LookupFn): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `invalid URL: ${raw}`;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `only http/https URLs are allowed (got ${u.protocol})`;
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return 'loopback/private hosts are blocked';
  }
  if (isIP(host)) {
    return isPrivateIp(host) ? 'loopback/private addresses are blocked' : null;
  }
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

// Minimal fetch-shaped client over node:http(s) so we can inject the guarded
// lookup (global fetch has no such hook). Only the surface fetchPublic uses:
// status, headers.get, body as a web ReadableStream; never follows redirects.
const pinnedFetch: FetchFn = ((input: string | URL, init?: RequestInit): Promise<Response> => {
  return new Promise((resolvePromise, rejectPromise) => {
    const u = new URL(String(input));
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
      u,
      {
        method: init?.method ?? 'GET',
        headers: init?.headers as Record<string, string> | undefined,
        lookup: guardedLookup as unknown as import('node:net').LookupFunction,
        signal: init?.signal ?? undefined,
      },
      (res) => {
        resolvePromise({
          ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
          status: res.statusCode ?? 0,
          headers: {
            get: (name: string) => {
              const v = res.headers[name.toLowerCase()];
              return Array.isArray(v) ? v.join(', ') : v ?? null;
            },
          },
          body: Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>,
        } as unknown as Response);
      },
    );
    req.on('error', rejectPromise);
    req.end();
  });
}) as FetchFn;

// ---------------------------------------------------------------------------
// Capped, redirect-checked fetch
// ---------------------------------------------------------------------------

export type FetchPublicResult =
  | { ok: true; finalUrl: string; status: number; contentType: string; body: string; truncatedBody: boolean }
  | { ok: false; error: string };

export async function fetchPublic(rawUrl: string, deps: WebDeps = {}): Promise<FetchPublicResult> {
  // Default transport is the pinned client (connect-time address validation);
  // tests inject a plain fetchFn and keep working unchanged.
  const fetchFn = deps.fetchFn ?? pinnedFetch;
  let url = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const guardErr = await guardPublicUrl(url, deps.lookupFn);
    if (guardErr) return { ok: false, error: guardErr };

    if (deps.signal?.aborted) return { ok: false, error: 'fetch cancelled' };
    const ctrl = new AbortController();
    const onOuterAbort = () => ctrl.abort();
    deps.signal?.addEventListener('abort', onOuterAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchFn(url, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          'user-agent': 'ue-mat-workflow-agent/1.0 (+local material viewer)',
          accept: 'text/html,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
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

export async function webSearch(query: string, deps: WebDeps = {}): Promise<
  { ok: true; results: SearchHit[] } | { ok: false; error: string }
> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const r = await fetchPublic(url, deps);
  if (!r.ok) return r;
  if (r.status !== 200) return { ok: false, error: `search endpoint returned HTTP ${r.status}` };
  const results = parseDuckDuckGoHtml(r.body);
  if (results.length === 0) {
    return { ok: false, error: 'no results parsed — the query found nothing or the search page layout changed' };
  }
  return { ok: true, results };
}
