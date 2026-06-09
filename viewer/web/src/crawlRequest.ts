export type CrawlKind = 'export' | 'enginemf' | 'workmf' | 'projectmat';

export type CrawlAction =
  | { type: 'crawlStarted'; kind: string; jobId: string }
  | { type: 'crawlAccepted'; jobId: string }
  | { type: 'crawlLog'; line: string }
  | { type: 'crawlDone'; status: 'success' | 'error'; exitCode: number | null };

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// contentRoots is honoured for kind 'workmf' and 'projectmat' (ignored otherwise).
export interface StartCrawlOpts { contentRoots?: string }

export async function cancelCrawlRequest(fetchImpl: FetchLike = fetch): Promise<boolean> {
  try {
    const r = await fetchImpl('/api/crawl/cancel', { method: 'POST', headers: { 'content-type': 'application/json' } });
    return r.ok;
  } catch {
    return false;
  }
}

export async function startCrawlRequest(kind: CrawlKind, dispatch: (action: CrawlAction) => void, opts: StartCrawlOpts = {}, fetchImpl: FetchLike = fetch): Promise<void> {
  dispatch({ type: 'crawlStarted', kind, jobId: '' });
  try {
    const r = await fetchImpl('/api/crawl', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, ...(opts.contentRoots ? { contentRoots: opts.contentRoots } : {}) }),
    });
    if (!r.ok) {
      const msg = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
      dispatch({ type: 'crawlLog', line: `crawl request rejected: ${msg.error ?? r.status}` });
      dispatch({ type: 'crawlDone', status: 'error', exitCode: null });
      return;
    }
    const accepted = await r.json().catch(() => null) as { jobId?: unknown } | null;
    if (typeof accepted?.jobId === 'string') dispatch({ type: 'crawlAccepted', jobId: accepted.jobId });
    // On success the server streams crawlStarted/crawlLog/crawlDone over the WS.
  } catch (e) {
    dispatch({ type: 'crawlLog', line: `crawl request error: ${(e as Error).message}` });
    dispatch({ type: 'crawlDone', status: 'error', exitCode: null });
  }
}
