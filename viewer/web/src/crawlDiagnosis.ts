// Maps a failed crawl's log output to a likely cause + fix, so the Config tab can
// tell an artist what went wrong and whether they can fix it themselves. The patterns
// are grounded in the real strings the PowerShell runners and the UE editor emit
// (tools/node-t3d-metadata/plugin-src/Scripts/*.ps1 throws + UE plugin-load errors).
// Extend RULES as new real failures surface — order matters (first match wins).

export interface CrawlDiagnosis {
  cause: string;
  fix: string;
  who: 'you' | 'maintainer';
}

interface Rule extends CrawlDiagnosis { test: RegExp; }

const RULES: Rule[] = [
  {
    test: /crawl found no project Material Functions|0 function\(s\)|Project materials staged:.*\(0 material\(s\),\s*0 function\(s\)/i,
    cause: '這次爬取正常啟動了 UE，但指定的 Content Route 底下沒有找到可爬取的材質或 Material Function。',
    fix: '回 Config 分頁，把對應的 Content Route 改成 UE Content Browser 裡的實際路徑，例如 /Game/G1/MaterialLibrary/Function 或 /Game/G1/MaterialLibrary/Material，然後重爬。',
    who: 'you',
  },
  {
    test: /could not be loaded|missing or incompatible modules|incompatible module|failed to load because|無法找到模組.*UEMatExportMetadata|插件.*UEMatExportMetadata.*加載失敗|插件.*UEMatExportMetadata.*加载失败/i,
    cause: 'UE 載入 UEMatExportMetadata 外掛失敗，通常是外掛二進位沒有對上目前的自訂引擎 build / Editor target。',
    fix: '先在終端機跑 Invoke-NodeT3DMetadataMaintenance.ps1 -ForcePackage，用目前設定的 EngineRoot 重新打包外掛；若仍失敗，請確認它是用你們專案實際使用的自訂引擎、Editor target 與必要模組依賴建出的版本。',
    who: 'you',
  },
  {
    test: /will shadow the packaged plugin/i,
    cause: '你的 UE 專案裡有一份 Plugins\\UEMatExportMetadata 副本，遮蔽了打包版外掛。',
    fix: '刪掉專案內那份 Plugins\\UEMatExportMetadata 副本後再爬。',
    who: 'you',
  },
  {
    test: /Packaged plugin not found/i,
    cause: '找不到已編譯外掛。',
    fix: '跑 Invoke-NodeT3DMetadataMaintenance.ps1 -ForcePackage 先把外掛打包好。',
    who: 'you',
  },
  {
    test: /BuildPlugin failed|Package-Plugin\.ps1 failed/i,
    cause: '對你的引擎重新打包外掛時編譯失敗（常見於 UE 版本間的 API 差異）。',
    fix: '看 BuildPlugin 的 log；若是 API 簽章不符（如 GetInputsAndOutputs / EFunctionInputType），需要工具維護者更新 commandlet。',
    who: 'maintainer',
  },
  {
    test: /Required path not found|ProjectPath not found|ProjectPath is required|EngineRoot is required|not provided and not found in local\.config\.json/i,
    cause: '專案或引擎路徑沒設好，或檔案不存在。',
    fix: '回 Config 分頁，確認 ProjectPath 指到 .uproject 檔、EngineRoot 指到 UnrealEngine 根目錄，存檔後再爬。',
    who: 'you',
  },
];

// First matching rule, or null when nothing in the log is recognised (caller then
// shows the raw log tail and suggests filing it with the maintainer).
export function diagnoseCrawl(logs: string[]): CrawlDiagnosis | null {
  const text = logs.join('\n');
  const r = RULES.find(rule => rule.test.test(text));
  return r ? { cause: r.cause, fix: r.fix, who: r.who } : null;
}

// A WorkMF crawl that succeeded but indexed 0 functions usually means the content
// root didn't point at the folder holding the project's Material Functions.
export function crawlFoundNothing(logs: string[]): boolean {
  return /\b0 function\(s\)/i.test(logs.join('\n'));
}
