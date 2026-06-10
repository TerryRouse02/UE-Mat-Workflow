# 節點 T3D 元資料工具（Node T3D Metadata Tooling）

> 繁體中文翻譯。英文版 `README.md` 為正式來源；若兩者有出入，以英文版為準。

這個資料夾是 UE 材質節點 T3D／匯出元資料的**自包含維護套件**。它與專案無關：只要傳入任一相容的 UE `.uproject` 與 `UnrealEngine` 根目錄，就能當作 commandlet 的執行宿主。

## 內容

- `Invoke-NodeT3DMetadataMaintenance.ps1`：一鍵元資料維護進入點。
- `audit-export-meta.js`：可重複使用的元資料稽核指令（現在也會偵測陣列元素 pin 的屬性漂移）。
- `heal-export-meta.js`：爬取後把陣列元素 pin 的標準 UE T3D 屬性（`CustomizedUVs(0)`、`Inputs(2)`…）重新套回，讓重新產生永遠不會退化它們。保留原格式且具冪等性，會在維護流程中自動執行；`--check` 只列出漂移、不寫檔。
- `check-public-purity.js`：公開產物純淨度閘門（CI 會跑）。若 committed 的 agent-pack 資料檔或 `stress_*` graph 外洩 `/Game`/`_project`、engine-MF index 有非 `/Engine/` 的 key、或 server-only/本機/Mac 二進位路徑被 git 追蹤，就失敗。任何重新產生 committed index 的爬取後跑一次。
- `build-db-candidates.js`：把節點探索（node-discovery）報告轉成可供審查的候選 DB 條目。
- `plugin-src/`：`UEMatExportMetadata` commandlet 的 UE 編輯器外掛原始碼。
- `plugin-src/Scripts/Run-NodeDiscovery.ps1`：列舉引擎運算式並與 DB 做差異比對。
- `plugin-src/Scripts/Run-WorkMfIndex.ps1`：索引「專案自己的」Material Function（WorkMF）。
- `plugin-src/Scripts/Run-EngineMfIndex.ps1`：把官方 `/Engine/Functions` 的 Material Function 索引成一份**已提交**的索引。
- `compiled/UEMatExportMetadata/`：已編譯的 Win64 外掛套件（**已提交**），毋需把外掛加進專案即可使用。在 macOS 上則以 `Package-Plugin.ps1` 在本機建置，產生的 `Binaries/Mac/*.dylib` 已 gitignore、不會提交。
- `host/NodeDiscoveryHost.uproject`：內附的精簡 UE 宿主專案，供節點探索使用（不需要遊戲專案；會停用脆弱的預設引擎外掛）。
- `docs/AGENT_WORKFLOW.md`：面向 agent 的工作流程，用於更新 `agent-pack\nodes-ue5.7.export.json`。
- `docs/NODE_DISCOVERY.md`：找出 DB 缺少哪些引擎運算式（節點探索）。
- `docs/WORKMF.md`：WorkMF 模式——把專案自己的 Material Function 索引進 `agent-pack\workmf-index.json`（本機、已 gitignore）。
- `docs/ENGINE_MF.md`：索引官方 `/Engine/Functions` 的 Material Function（已提交）。
- `docs/PROJECT_MATERIALS.md`：ProjectMat 模式——把 `/Game` 的 UMaterial 匯出成 T3D dump，讓 viewer 能開啟它們。
- `docs/VERIFICATION.md`：必跑的稽核與測試指令。
- `skill/node-t3d-metadata/SKILL.md`：給 Codex、Claude 或其他 agent 使用的可攜式 skill 說明。

## 一般流程

同一套 `.ps1` runner 在 **Windows 與 macOS** 上都能跑。Windows 用內建的 Windows PowerShell 5.1（指令叫 `powershell`）；macOS 用 PowerShell Core 7（指令叫 `pwsh`，透過官方 PowerShell `.pkg` 或 `brew install --cask powershell` 安裝）。runner 會以 `$IsMacOS` 自動偵測平台並選對 UE 編輯器執行檔（Windows：`Engine\Binaries\Win64\UnrealEditor-Cmd.exe`；macOS：`Engine/Binaries/Mac/UnrealEditor-Cmd`）。下面以 Windows 為例；macOS 把 `powershell -ExecutionPolicy Bypass -File` 換成 `pwsh -File`、並改用原生路徑（如 `/path/to/Project.uproject`、`/path/to/UnrealEngine`）即可。

從工作流程 repo 根目錄執行：

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine>

# macOS
pwsh -File ./tools/node-t3d-metadata/Invoke-NodeT3DMetadataMaintenance.ps1 \
  -ProjectPath /path/to/Project.uproject \
  -EngineRoot /path/to/UnrealEngine
```

只有在已編譯外掛**遺失、被強制重建，或比 `plugin-src/` 還舊**時，進入點才會重建它；接著重新產生 `agent-pack\nodes-ue5.7.export.json`、修復其陣列元素 pin 屬性、稽核元資料，並執行針對性的 viewer 測試。

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

同一個 commandlet／外掛還支援額外幾種模式（各有一鍵執行腳本）：

- **節點探索（Node discovery）**——列舉引擎編譯進來的每一個 `UMaterialExpression`，並與編寫 DB 做差異比對，讓你拿到一份「到底缺哪些節點」的報告。執行 `plugin-src\Scripts\Run-NodeDiscovery.ps1`；細節見 `docs\NODE_DISCOVERY.md`。
- **WorkMF**——以 UE 資產路徑索引「專案自己的」Material Function，讓 viewer、匯出器與編寫 agent 都能使用它們。執行 `plugin-src\Scripts\Run-WorkMfIndex.ps1`；細節見 `docs\WORKMF.md`。其輸出保留在本機且已 gitignore。
- **Engine MF**——同一套爬取，指向官方 `/Engine/Functions` 函式庫，讓呼叫內建 MF（CustomRotator、BumpOffset_Advanced…）的材質能帶著正確的引腳往返。執行 `plugin-src\Scripts\Run-EngineMfIndex.ps1`；細節見 `docs\ENGINE_MF.md`。它的輸出**是會提交的**（所有使用者共用的穩定出貨資料）。
- **ProjectMat**——把 `/Game` 下每個 `UMaterial` 匯出為 UE T3D 剪貼板 dump，寫入本機暫存目錄（`tools/node-t3d-metadata/projectmat-staging/`，已 gitignore）。爬取完成後，viewer server 讀取這些 dump，用與剪貼板「導入」相同的 T3D→matgraph 轉換流程，把結果寫進 `graphs/_project/`（同樣已 gitignore）。執行 `plugin-src\Scripts\Run-ProjectMaterials.ps1`；可用 `-ContentRoots` 縮小或擴大爬取範圍（預設 `/Game`）。細節見 `docs\PROJECT_MATERIALS.md`。

## 從 web viewer 觸發爬取（免終端機）

上面三種爬取也可以**直接在 viewer 的 Config 分頁**完成（側欄第三個分頁，在 Files、Nodes 旁邊）——
免終端機、免手改 JSON。它是**本機優先（local-first）**：viewer server、`UnrealEditor-Cmd`、
瀏覽器全部跑在**同一台機器**上（Windows 或 macOS；server 綁 `127.0.0.1`，而且只有同源、同機的網頁才能
設定或啟動爬取）。

### 1. 啟動 viewer

在裝有 UE 的機器（Windows 或 macOS）、從 repo 根目錄：

```bash
pnpm build && pnpm start     # 提供 http://localhost:5790（會自動嘗試 5790-5799）
# 正在改 UI？改用：  pnpm dev
```

在**那台機器上**的瀏覽器開啟 `http://localhost:5790`，點 **Config** 分頁。

### 2. 設定專案路徑（在 Config 分頁）

在 **專案路徑** 區塊填入 **`.uproject` 路徑**（`ProjectPath`）與 **UE 引擎根目錄**（`EngineRoot`），
按 **儲存設定**。路徑用各 OS 的原生寫法（Windows 如 `C:\\Path\\To\\Project.uproject`、`C:\\Path\\To\\UnrealEngine`；
macOS 如 `/path/to/Project.uproject`、`/path/to/UnrealEngine`）。這會幫你寫好 `tools/node-t3d-metadata/local.config.json`（已 gitignore、每台機器
自己一份）——就是 PowerShell 腳本讀的那個檔，所以你完全不必手改 JSON。（要手動先填、或用
[一般流程](#一般流程)先建好也可以。）

**不會在你的 UE 專案放任何東西。** 爬取是用 UE 命令列直接從 `compiled/` 掛載打包好的外掛
（`UnrealEditor-Cmd.exe <專案> -plugin=<compiled .uplugin> …`），所以你的專案資料夾完全不會被動到——
而且只要你專案裡**存在 `Plugins\UEMatExportMetadata\` 副本，爬取會直接拒跑**（那個副本會遮蔽打包版，
這正是 `noShadow` 檢查在防的事）。因為已編譯外掛已隨 repo 提交，所以開箱即用；只有改過 `plugin-src/`
才需重建。

> **唯一例外（外掛二進位要對得上引擎）。** committed 的二進位是針對某個 UE 5.7 build 編的 Win64。若你的引擎
> 是不同 build、而爬取因此**載入**外掛失敗，就對**你自己的引擎**重打包一次：
> `Invoke-NodeT3DMetadataMaintenance.ps1 -ForcePackage`——依然是外部、依然不會拷貝進你的專案。
> （探測只檢查二進位是否存在，不檢查是否吻合你的引擎，所以這會以爬取當下的載入錯誤出現，而不是紅色檢查。）
> 在 **macOS** 上沒有提交的二進位，必須先在本機建一次：用 `Package-Plugin.ps1`（需要 Xcode，以及一份
> `Engine/Build/BatchFiles/RunUAT.sh` 存在的 UE 編輯器），它會產生 gitignore 的 `Binaries/Mac/*.dylib`。
> macOS 上 `Package-Plugin.ps1` 會打包到暫存目錄、只把 `Binaries/Mac` 複製進外掛資料夾，所以 macOS 的
> （重）打包永遠不會蓋掉已提交的 Win64 二進位或 `.uplugin`。

### 3. 看環境檢查清單

**環境檢查** 區塊會把每一項探測變成綠 ✓／紅 ✗ 一列，讓你一眼看出還缺什麼、不用猜。全部變綠後，
爬取按鈕才會啟用：

| 檢查項 | 意義 |
|---|---|
| platform | 跑在 Windows 或 macOS 上 |
| config | `local.config.json` 有 `ProjectPath` + `EngineRoot` |
| engine | 在 `EngineRoot` 底下找到平台對應的 `UnrealEditor-Cmd`（Windows 為 `UnrealEditor-Cmd.exe`） |
| project | `ProjectPath` 指向存在的 `.uproject` **檔案**（不是資料夾） |
| plugin | 已編譯外掛二進位存在（Windows `compiled/` 隨 repo 出貨；macOS 為本機建的 `Binaries/Mac`） |
| noShadow | 專案內沒有 `Plugins\UEMatExportMetadata` 副本遮蔽打包版外掛 |

### 4. 爬取

清單全綠後，**爬取 UE 元資料** 區塊的按鈕會執行本 README 所記載的同一套腳本（從
`local.config.json` 讀 `ProjectPath` / `EngineRoot`）；進度直接串流在面板裡，每次完成後 viewer
即時刷新。同一時間只跑一個。

| 按鈕 | kind | 寫入 | 腳本 |
|---|---|---|---|
| 重爬節點匯出 | export | `agent-pack\nodes-ue5.7.export.json` | `Invoke-NodeT3DMetadataMaintenance.ps1 -SkipViewerTests` |
| 重爬引擎 MF | enginemf | `agent-pack\enginemf-index-ue5.7.json` | `plugin-src\Scripts\Run-EngineMfIndex.ps1` |
| 重爬專案 MF | workmf | `agent-pack\workmf-index.json`（本機、已 gitignore） | `plugin-src\Scripts\Run-WorkMfIndex.ps1 -ContentRoots <root>` |
| 重爬專案母材質 | projectmat | `graphs\_project\<Name>\<Name>.matgraph.json`（本機、已 gitignore） | `plugin-src\Scripts\Run-ProjectMaterials.ps1 -ContentRoots <root>` |

爬取的範圍來自 Config 分頁那個**單一** **MF content root** 欄位（預設 `/Game`）——**一個資料夾**，
也就是導出解析本地 MF 用的同一個。依大廠材質規範,專案 MF 都集中在單一資料夾,所以爬取只掃這一個。

## Agent Skill

可攜式 skill 位於 `skill/node-t3d-metadata/SKILL.md`。任何 agent 直接讀那個檔案即可使用。若要安裝到某個 agent 專屬的 skill 註冊處，把整個 `skill/node-t3d-metadata` 資料夾複製到該 agent 的 skills 目錄即可。
