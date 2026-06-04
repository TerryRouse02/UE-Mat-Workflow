import { describe, expect, it } from 'vitest';
import { startCrawlRequest, type CrawlAction } from '../web/src/crawlRequest';

describe('startCrawlRequest', () => {
  it('marks the crawl running before waiting for the POST response', async () => {
    let resolveFetch!: (r: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    const actions: CrawlAction[] = [];

    const request = startCrawlRequest(
      'enginemf',
      (action) => actions.push(action),
      () => fetchPromise,
    );

    expect(actions[0]).toEqual({ type: 'crawlStarted', kind: 'enginemf', jobId: '' });

    resolveFetch(new Response(JSON.stringify({ jobId: 'crawl-7' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await request;

    expect(actions).toContainEqual({ type: 'crawlAccepted', jobId: 'crawl-7' });
  });
});
