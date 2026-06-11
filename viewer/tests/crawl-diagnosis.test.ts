import { describe, it, expect } from 'vitest';
import { diagnoseCrawl, crawlFoundNothing } from '../web/src/crawlDiagnosis';

describe('diagnoseCrawl', () => {
  it('maps a plugin load failure to the -ForcePackage fix (user-fixable)', () => {
    const d = diagnoseCrawl(['booting', 'Plugin failed to load because module X could not be loaded', 'exit 3']);
    expect(d).not.toBeNull();
    expect(d!.who).toBe('you');
    expect(d!.fix).toMatch(/-ForcePackage/);
  });

  it('maps the localized UE plugin module failure to the -ForcePackage fix', () => {
    const d = diagnoseCrawl(['LogPluginManager: Error: 無法找到模組“UEMatExportMetadata”，因此插件“UEMatExportMetadata”加载失败。']);
    expect(d).not.toBeNull();
    expect(d!.who).toBe('you');
    expect(d!.fix).toMatch(/-ForcePackage/);
  });

  it('routes a BuildPlugin compile failure to the maintainer', () => {
    const d = diagnoseCrawl(['BuildPlugin failed with exit code 6. Log: x']);
    expect(d!.who).toBe('maintainer');
  });

  it('maps a missing path to the Config-tab fix', () => {
    const d = diagnoseCrawl(['Required path not found: C:\\proj.uproject']);
    expect(d!.who).toBe('you');
    expect(d!.fix).toMatch(/Config/);
  });

  it('maps a zero-result crawl to a content route fix', () => {
    const d = diagnoseCrawl(['Project materials staged: staging (0 material(s), 0 function(s), 0 failure(s))']);
    expect(d).not.toBeNull();
    expect(d!.who).toBe('you');
    expect(d!.fix).toMatch(/Content Route/);
  });

  it('returns null for an unrecognised failure', () => {
    expect(diagnoseCrawl(['some unfamiliar error text'])).toBeNull();
  });
});

describe('crawlFoundNothing', () => {
  it('detects a 0-function WorkMF result', () => {
    expect(crawlFoundNothing(['Wrote work-MF index: x (0 function(s), 0 load failure(s))'])).toBe(true);
  });
  it('is false when functions were indexed', () => {
    expect(crawlFoundNothing(['Wrote work-MF index: x (12 function(s), 0 load failure(s))'])).toBe(false);
  });
});
