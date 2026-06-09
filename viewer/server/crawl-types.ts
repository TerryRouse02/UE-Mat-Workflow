// Node-free shared types for the crawl env probe, imported by both the server
// (crawl-env.ts) and the web (store.tsx). Kept free of node imports so pulling it
// into the web's tsc program adds no node typing requirement — same approach as
// db-types.ts.

export interface EnvCheck {
  ok: boolean;
  detail: string;
}

export interface CrawlFreshness {
  export?: string | null;
  enginemf?: string | null;
  workmf?: string | null;
  projectmat?: string | null;
}

export interface EnvStatus {
  ready: boolean;            // every check passed → the crawl button is enabled
  platform: string;
  projectPath: string | null;
  engineRoot: string | null;
  checks: Record<string, EnvCheck>;
  freshness?: CrawlFreshness;
}
