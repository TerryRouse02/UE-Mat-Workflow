// Maps a failed crawl's log output to a likely cause + fix, so the Config tab can
// tell an artist what went wrong and whether they can fix it themselves. The patterns
// are grounded in the real strings the PowerShell runners and the UE editor emit
// (tools/node-t3d-metadata/plugin-src/Scripts/*.ps1 throws + UE plugin-load errors).
// Extend RULES as new real failures surface — order matters (first match wins).

import i18n from './i18n';

export interface CrawlDiagnosis {
  cause: string;
  fix: string;
  who: 'you' | 'maintainer';
}

interface Rule { test: RegExp; causeKey: string; fixKey: string; who: 'you' | 'maintainer'; }

const RULES: Rule[] = [
  {
    test: /crawl found no project Material Functions|0 function\(s\)|Project materials staged:.*\(0 material\(s\),\s*0 function\(s\)/i,
    causeKey: 'crawlDiagnosis.noMaterialsCause',
    fixKey: 'crawlDiagnosis.noMaterialsFix',
    who: 'you',
  },
  {
    test: /could not be loaded|missing or incompatible modules|incompatible module|failed to load because|無法找到模組.*UEMatExportMetadata|插件.*UEMatExportMetadata.*加載失敗|插件.*UEMatExportMetadata.*加载失败/i,
    causeKey: 'crawlDiagnosis.pluginLoadCause',
    fixKey: 'crawlDiagnosis.pluginLoadFix',
    who: 'you',
  },
  {
    test: /will shadow the packaged plugin/i,
    causeKey: 'crawlDiagnosis.shadowPluginCause',
    fixKey: 'crawlDiagnosis.shadowPluginFix',
    who: 'you',
  },
  {
    test: /Packaged plugin not found/i,
    causeKey: 'crawlDiagnosis.packagedNotFoundCause',
    fixKey: 'crawlDiagnosis.packagedNotFoundFix',
    who: 'you',
  },
  {
    test: /BuildPlugin failed|Package-Plugin\.ps1 failed/i,
    causeKey: 'crawlDiagnosis.buildPluginCause',
    fixKey: 'crawlDiagnosis.buildPluginFix',
    who: 'maintainer',
  },
  {
    test: /Required path not found|ProjectPath not found|ProjectPath is required|EngineRoot is required|not provided and not found in local\.config\.json/i,
    causeKey: 'crawlDiagnosis.pathNotFoundCause',
    fixKey: 'crawlDiagnosis.pathNotFoundFix',
    who: 'you',
  },
];

// First matching rule, or null when nothing in the log is recognised (caller then
// shows the raw log tail and suggests filing it with the maintainer).
export function diagnoseCrawl(logs: string[]): CrawlDiagnosis | null {
  const text = logs.join('\n');
  const r = RULES.find(rule => rule.test.test(text));
  return r ? { cause: i18n.t(r.causeKey), fix: i18n.t(r.fixKey), who: r.who } : null;
}

// A WorkMF crawl that succeeded but indexed 0 functions usually means the content
// root didn't point at the folder holding the project's Material Functions.
export function crawlFoundNothing(logs: string[]): boolean {
  return /\b0 function\(s\)/i.test(logs.join('\n'));
}
