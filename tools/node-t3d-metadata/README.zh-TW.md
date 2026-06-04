# 節點 T3D 元資料工具（Node T3D Metadata Tooling）

> 繁體中文翻譯。英文版 `README.md` 為正式來源；若兩者有出入，以英文版為準。

這個資料夾是 UE 材質節點 T3D／匯出元資料的**自包含維護套件**。它與專案無關：只要傳入任一相容的 UE `.uproject` 與 `UnrealEngine` 根目錄，就能當作 commandlet 的執行宿主。

## 內容

- `Invoke-NodeT3DMetadataMaintenance.ps1`：一鍵元資料維護進入點。
- `audit-export-meta.js`：可重複使用的元資料稽核指令。
- `build-db-candidates.js`：把節點探索（node-discovery）報告轉成可供審查的候選 DB 條目。
- `plugin-src/`：`UEMatExportMetadata` commandlet 的 UE 編輯器外掛原始碼。
- `plugin-src/Scripts/Run-NodeDiscovery.ps1`：列舉引擎運算式並與 DB 做差異比對。
- `plugin-src/Scripts/Run-WorkMfIndex.ps1`：索引「專案自己的」Material Function（WorkMF）。
- `plugin-src/Scripts/Run-EngineMfIndex.ps1`：把官方 `/Engine/Functions` 的 Material Function 索引成一份**已提交**的索引。
- `compiled/UEMatExportMetadata/`：已編譯的 Win64 外掛套件，毋需把外掛加進專案即可使用。
- `host/NodeDiscoveryHost.uproject`：內附的精簡 UE 宿主專案，供節點探索使用（不需要遊戲專案；會停用脆弱的預設引擎外掛）。
- `docs/AGENT_WORKFLOW.md`：面向 agent 的工作流程，用於更新 `agent-pack\nodes-ue5.7.export.json`。
- `docs/NODE_DISCOVERY.md`：找出 DB 缺少哪些引擎運算式（節點探索）。
- `docs/WORKMF.md`：WorkMF 模式——把專案自己的 Material Function 索引進 `agent-pack\workmf-index.json`（本機、已 gitignore）。
- `docs/ENGINE_MF.md`：索引官方 `/Engine/Functions` 的 Material Function（已提交）。
- `docs/VERIFICATION.md`：必跑的稽核與測試指令。
- `skill/node-t3d-metadata/SKILL.md`：給 Codex、Claude 或其他 agent 使用的可攜式 skill 說明。

## 一般流程

從工作流程 repo 根目錄執行：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine>
```

只有在已編譯外掛**遺失、被強制重建，或比 `plugin-src/` 還舊**時，進入點才會重建它；接著重新產生 `agent-pack\nodes-ue5.7.export.json`、稽核元資料，並執行針對性的 viewer 測試。

實用選項：

```powershell
# 即使已編譯外掛看起來是最新的，仍強制重新打包外掛。
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine> `
  -ForcePackage

# 順便刷新 MakeMaterialAttributes 的剪貼簿校準 fixture。
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine> `
  -CaptureFixtures

# 把「本專案自己的」Material Function 爬進 agent-pack\workmf-index.json
#（本機 + 已 gitignore）。只有當你的圖以資產路徑引用自己的 /Game MF 時才需要；
# 只跑爬取，不會重新產生節點元資料。詳見 docs/WORKMF.md。
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine> `
  -WorkMF

# 擷取核心 MaterialGraphNode 的剪貼簿校準 fixture。
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Capture-CoreClipboardSample.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine> `
  -TextureAsset /Game/Textures/T_Mask.T_Mask

# 擷取 TextureSample / TextureSampleParameter2D 的貼圖引用語法。
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Capture-TextureSampleSources.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine> `
  -TextureAsset /Game/Textures/T_Mask.T_Mask
```

日誌寫在本 repo 的 `Logs\UE` 底下；預設的外部外掛流程不會更動宿主 UE 專案。

## 其他模式

同一個 commandlet／外掛還支援另外兩種模式（各有一鍵執行腳本）：

- **節點探索（Node discovery）**——列舉引擎編譯進來的每一個 `UMaterialExpression`，並與編寫 DB 做差異比對，讓你拿到一份「到底缺哪些節點」的報告。執行 `plugin-src\Scripts\Run-NodeDiscovery.ps1`；細節見 `docs\NODE_DISCOVERY.md`。
- **WorkMF**——以 UE 資產路徑索引「專案自己的」Material Function，讓 viewer、匯出器與編寫 agent 都能使用它們。執行 `plugin-src\Scripts\Run-WorkMfIndex.ps1`；細節見 `docs\WORKMF.md`。其輸出保留在本機且已 gitignore。
- **Engine MF**——同一套爬取，指向官方 `/Engine/Functions` 函式庫，讓呼叫內建 MF（CustomRotator、BumpOffset_Advanced…）的材質能帶著正確的引腳往返。執行 `plugin-src\Scripts\Run-EngineMfIndex.ps1`；細節見 `docs\ENGINE_MF.md`。它的輸出**是會提交的**（所有使用者共用的穩定出貨資料）。

## 從 web viewer 觸發爬取（免終端機）

上面三種爬取也可以**直接從 viewer 的瀏覽器介面**觸發——標題列有一顆 **`爬取`** 按鈕——
所以刷新元資料完全不必開終端機。它是**本機優先（local-first）**：viewer server、
`UnrealEditor-Cmd.exe`、瀏覽器全部跑在**同一台 Windows 機器**上（server 綁 `127.0.0.1`，
而且只有同源、同機的網頁才能啟動爬取）。

### 1. 配置外掛（一次性）

按鈕所需的一切都讀自 `local.config.json`——瀏覽器裡不必輸入任何路徑。

1. **Windows + UE**——爬取會啟動 `UnrealEditor-Cmd.exe`，所以按鈕只在裝有 UE 的 Windows 上有效。
2. **`local.config.json`**——把 `local.config.example.json` 複製成 `local.config.json`，填入
   `ProjectPath`（`.uproject` **檔案**）與 `EngineRoot`（你的 `UnrealEngine` 根目錄）。此檔已
   gitignore（每台機器自己一份），是按鈕唯一讀取的設定來源。
3. **已編譯外掛**——已隨 repo 提交在 `compiled/` 底下，所以 plugin 檢查開箱即綠。只有在你改過
   `plugin-src/` 時才需要重建（跑一次[一般流程](#一般流程)，或加 `-ForcePackage`）。
4. **沒有遮蔽用的副本**——確認你的 UE 專案裡**沒有**自己的 `Plugins\UEMatExportMetadata\` 副本；
   專案內的副本會遮蔽打包版，探測會因此擋下爬取。

### 2. 把 viewer link 起來

在同一台 Windows 機器、從 repo 根目錄：

```bash
pnpm build && pnpm start     # 提供 http://localhost:5790（會自動嘗試 5790-5799）
# 正在改 UI？改用：  pnpm dev
```

在**那台機器上**的瀏覽器開啟 `http://localhost:5790`。

### 3. 點亮按鈕

標題列的 **`爬取`** 按鈕會在本機環境探測全綠時自動啟用。若它一直是灰的，**把游標移上去**——
提示會明確列出是哪一項檢查沒過。所有檢查都必須通過：

| 檢查項 | 意義 |
|---|---|
| platform | 跑在 Windows 上 |
| config | `local.config.json` 有 `ProjectPath` + `EngineRoot` |
| engine | 在 `EngineRoot` 底下找到 `UnrealEditor-Cmd.exe` |
| project | `ProjectPath` 指向存在的 `.uproject` **檔案**（不是資料夾） |
| plugin | 已編譯外掛 DLL 存在（隨 `compiled/` 出貨） |
| noShadow | 專案內沒有 `Plugins\UEMatExportMetadata` 副本遮蔽打包版外掛 |

### 各選項實際執行什麼

點 **`爬取`** 會展開一個有三種爬取的選單；每一項都執行本 README 所記載的同一套腳本（從
`local.config.json` 讀 `ProjectPath` / `EngineRoot`），完成後 viewer 即時刷新：

| 選單項目 | kind | 寫入 | 腳本 |
|---|---|---|---|
| 重爬節點匯出 | export | `agent-pack\nodes-ue5.7.export.json` | `Invoke-NodeT3DMetadataMaintenance.ps1 -SkipViewerTests` |
| 重爬引擎 MF | enginemf | `agent-pack\enginemf-index-ue5.7.json` | `plugin-src\Scripts\Run-EngineMfIndex.ps1` |
| 重爬專案 MF | workmf | `agent-pack\workmf-index.json`（本機、已 gitignore） | `plugin-src\Scripts\Run-WorkMfIndex.ps1 -ContentRoots <roots>` |

**專案 MF（workmf）** 那一項有一個 **Content Root** 欄位（預設 `/Game`；多個用逗號分隔），指定要
爬專案裡哪些資料夾，並顯示解析後的專案路徑。第一次啟動編輯器要等幾分鐘——進度會串流進浮層，
完成時用 toast 回報成功或失敗。同一時間只跑一個爬取（前一個還沒結束時，第二次會被拒絕）。

## Agent Skill

可攜式 skill 位於 `skill/node-t3d-metadata/SKILL.md`。任何 agent 直接讀那個檔案即可使用。若要安裝到某個 agent 專屬的 skill 註冊處，把整個 `skill/node-t3d-metadata` 資料夾複製到該 agent 的 skills 目錄即可。
