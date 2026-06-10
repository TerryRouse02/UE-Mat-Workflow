# UE Material Workflow

AI 與人協作 UE 5.7 材質節點圖的統一工作流。AI 輸出標準 `.matgraph.json` 格式，本地 viewer 即時呈現節點圖，忠實還原 UE 表達式樣貌。

[English](./README.md)

---

## 為什麼用這套

- **不要再用文字牆描述節點圖了。** AI 用嚴格 JSON schema 描述材質，viewer 渲染成像真的 UE 節點。
- **不要再讓 AI 亂編節點名了。** 釘住的 UE 5.7 節點 DB（296 個 expression——幾乎是引擎完整集合）是 single source of truth——AI 必須用已存在的節點型別、精確的 pin 名稱、精確的 param 名稱。viewer 還會標出「連到不存在 pin」的連線。
- **最終輸出不再斷線。** 你把結果直接接進 `MaterialOutput` 節點；導出時 emitter 會自動把它們收進一個 `MakeMaterialAttributes` 節點，貼進 UE 只需接 1 根線，而不是每個屬性接一根。
- **一套格式跨 AI 工具。** 同一個 `agent-pack/` 在 Claude Code、Cursor、Copilot CLI、Gemini CLI 或任何能讀 agent rules 的工具裡都能用。

---

## 安裝

```bash
git clone https://github.com/TerryRouse02/UE-Mat-Workflow.git
cd UE-Mat-Workflow
pnpm install
pnpm build
```

需要 Node 18+ 和 pnpm。沒裝 pnpm 用 `npx pnpm install` 也行。

---

## 啟動 viewer

```bash
pnpm start
# → http://localhost:5790（自動嘗試 5790–5799）
```

**在改 viewer 的程式碼？** 改用 dev 模式 —— 它會在每次存檔時重新編譯 UI，你只要刷新瀏覽器（不用手動 `pnpm build`、不用重啟）：

```bash
pnpm dev
# 改任何 UI 檔 → 存檔 → 刷新瀏覽器（F5）
```

（後端/server 的 `.ts` 改動仍需重跑一次 `pnpm dev`。）

Sidebar 有三個 tab：

| Tab | 內容 |
|---|---|
| **Files** | 你的材質，依專案資料夾分組。`graphs/` 下每個子資料夾就是一個專案，裡面所有檔案都會顯示；只有直接放在 `graphs/` 根層的檔案會落到「Unorganized」區。 |
| **Nodes** | UE 5.7 完整節點庫——可依名稱或描述搜尋、按分類瀏覽，點節點看 inputs / outputs / params 細節，包含型別與徽章（verified、dynamic-pin、deprecated）。下方還有兩個可摺疊瀏覽器：**Official Material Functions**（引擎的 `/Engine/Functions` 函式庫）與 **Project Material Functions**（你自己的 `/Game` MF，WorkMF 爬取索引後即時顯示）。 |
| **Config** | 填入爬取要用的 `ProjectPath` + `EngineRoot` 按 **儲存設定**（幫你寫好 `local.config.json`）、看環境檢查清單、執行 UE 元資料爬取——全程按鈕操作、免終端機。Windows 與 macOS 皆可；見 [從瀏覽器刷新 UE 元資料](#從瀏覽器刷新-ue-元資料windows--macos)。 |

檔案變動時 viewer 會自動 reload。

---

## 從瀏覽器刷新 UE 元資料（Windows / macOS）

viewer 可以自己跑本機 UE 爬取——側欄的 **Config 分頁**免開終端機就能重新產生節點匯出元資料、
引擎 MF 索引、或你自己的專案 MF 索引。它是**本機優先**：server、`UnrealEditor-Cmd`、瀏覽器
全部跑在同一台機器上。Windows 與 macOS 皆可：Windows 用 Windows PowerShell 5.1（`powershell`），
macOS 用 PowerShell Core 7（`pwsh`，透過官方 PowerShell `.pkg` 或 `brew install --cask powershell` 安裝）。
兩者共用同一組 `.ps1` runner，會自動偵測平台對應的編輯器執行檔
（Windows：`Engine\Binaries\Win64\UnrealEditor-Cmd.exe`；macOS：`Engine/Binaries/Mac/UnrealEditor-Cmd`）。

在 Config 分頁填入 `ProjectPath` + `EngineRoot` 按 **儲存設定**（它會幫你寫好
`tools/node-t3d-metadata/local.config.json`，免改 JSON），看環境檢查清單變綠，再按爬取按鈕即可。
完整步驟見 [`tools/node-t3d-metadata/README.zh-TW.md`](./tools/node-t3d-metadata/README.zh-TW.md)
的「從 web viewer 觸發爬取」一節。

---

## 搭配 AI 工具使用

`agent-pack/` 目錄裡有 spec、node DB、範例，以及給各主流 AI 工具的規則檔。把工具指向這個 repo 就能開始下 prompt。

### Token 高效 DB 存取

完整的 `nodes-ue*.json` 撰寫 DB 有 45K–120K tokens——太大，不能整個塞進每次 AI session。Agent 規則改用**漸進式查詢**協議：

1. 讀 `agent-pack/nodes-ue<version>.index.json`（~12K tokens，可整檔讀取）選節點。Index 由 CI 自動產生並與完整 DB 比對。
2. 只針對你要用的節點取得完整條目：`node agent-pack/query.js node 5.7 Multiply Lerp Fresnel`
3. 查詢 Material Function pin 簽名：`node agent-pack/query.js mf "/Engine/Functions/.../Foo.Foo"`

`nodes-ue*.export.json` 只供 viewer 的匯出／匯入程式碼使用，撰寫用的 agent 永遠不需要讀它。`enginemf-index-ue*.json` 只支援點查詢，透過 `query.js mf` 存取。

### Claude Code

`agent-pack/CLAUDE.md` 會被自動讀取。在這個 repo 的任何對話裡：

> 「幫我做一個風格化水材質，加上 normal map 扭曲和 fresnel 邊緣輝光。」

Claude 會讀 `SPEC.md`、查閱 `nodes-ue5.7.index.json` 選節點、透過 `query.js` 取得完整條目，並把 JSON 寫到 `graphs/<project>/`。Viewer 立刻渲染。

### Cursor

`agent-pack/.cursorrules` 會被自動讀取。Prompt 流程相同。

### Copilot CLI / Codex / 通用 agent

`agent-pack/AGENTS.md` 是大多數通用 agent CLI 採用的慣例。在 repo root 執行並 prompt：

> 「讀 agent-pack/SPEC.md，然後把金屬鏽蝕混合材質寫到 graphs/。」

### Gemini CLI

`agent-pack/GEMINI.md` 會被自動讀取。流程相同。

### 其他工具

任何能指定 spec 檔的工具都可以——把 `agent-pack/SPEC.md` 和 `agent-pack/nodes-ue5.7.json` 給它，叫它把 `.matgraph.json` 寫到 `graphs/<project>/`。

---

## AI 產出的檔案結構

一個專案 = 一個資料夾。資料夾內恰好包含 1 個 Material 加上它用到的 MF（專案內自有，不跨專案共享）。

```
graphs/
├── obsidian/
│   ├── obsidian.matgraph.json          [Material]
│   └── fresnel_lib.matgraph.json       [MaterialFunction]
└── flashing_emissive/
    ├── flashing_emissive.matgraph.json
    └── sine_pulse.matgraph.json
```

慣例：資料夾名 = 材質名。JSON 內部的 MaterialFunction 路徑用同層相對寫法：`"./fresnel_lib.matgraph.json"`。

---

## 匯出 & 分享

要把節點圖傳給沒裝 Node 的人：

```bash
node viewer/dist/server/html-export.js export <project>/<name> --out ./shared.html
```

產出單一獨立的 `.html` 檔案。雙擊即可瀏覽。

---

## 從 UE 匯入

剪貼板橋接是**雙向**的。在 viewer 點 **導入**，把 UE 的材質選取貼進來——在 Material Editor
選取節點、`Ctrl+C`，貼到輸入框。viewer 會**完全在本地**（不需要 Unreal）把它還原成
`.matgraph.json`（節點型別、params、連線、註釋、reroute），寫成 `graphs/` 下的新專案資料夾並開啟。

無法對映的東西——節點 DB 裡沒有的 UE class、或 pin 名需要函數定義的 Material Function——會以
warning 呈現，絕不臆造。（Reroute「knot」直通節點會被收合：連線改接到 reroute 真正的來源，不會斷線。）

---

## 範例

`agent-pack/examples/` 的參考檔每個都已是合規專案資料夾（`<name>/<name>.matgraph.json`，引用的 MaterialFunction 複製在同資料夾、不共享）。要試用某個，直接整個資料夾複製到 `graphs/`：

```bash
cp -r agent-pack/examples/02_with_function graphs/
```

viewer 會在左側欄把它歸為一個專案，導出到 UE 也直接可用，不需改任何路徑。

---

## 多版本 UE 支援

節點 DB 是**依版本切分**的，以版本成對的形式放在 `agent-pack/`：

- `nodes-ue<major.minor>.json` —— 撰寫用的 DB（AI 的字典）。
- `nodes-ue<major.minor>.export.json` —— 「匯出到 UE」用的每節點 UE 元數據。

目前是 `nodes-ue5.7.json` + `nodes-ue5.7.export.json`；之後會有 `nodes-ue5.8.*` 等。Viewer 在 build 時自動探索所有存在的版本，並依每張圖的 `ueVersion` 欄位挑選對應的成對檔案。若某張圖指定了不支援的版本，viewer 會顯示明確的橫幅提示，並擋下可靠的匯出。

**擴充新版本只是丟資料、不用改程式：** 用 UE commandlet（`tools/node-t3d-metadata`）針對該引擎版本產出這兩個檔案，丟進 `agent-pack/` 即可。

> 對 AI 下 prompt 時，先告訴它你要做哪個 UE 版本 —— agent 規則要求它在寫任何 `.matgraph.json` 之前，必須先確認版本受支援。

---

## 補充節點 DB

DB 依版本切分：編輯你目標版本的那一份（例如 `agent-pack/nodes-ue5.7.json`，目前有 296 個 expression）。要新增：

1. 從 [UE Material Expression Reference](https://dev.epicgames.com/documentation/en-us/unreal-engine/material-expression-reference) 查節點。
2. 仿照現有條目格式新增到 `nodes.<NodeName>`（inputs、outputs、params、category、description）。
3. `verified: true` 只在你親自核對過後才設。（自動發現、尚未人工核對的節點維持 `verified: false`——pin 名是從 UE 反射來的，但型別可能是佔位值。）
4. 跑 `pnpm test` 確認 DB 仍合法。

**不知道缺哪些節點？** commandlet 會告訴你。它的節點發現模式會枚舉引擎內所有 `UMaterialExpression`，
跟 DB 比對，產出「缺哪些節點」的報告——見 `tools/node-t3d-metadata/docs/NODE_DISCOVERY.md`。

（若要支援一個全新的 UE 版本，而不是擴充現有版本，請見 [多版本 UE 支援](#多版本-ue-支援) —— 用 commandlet 產出該版本的成對檔案，不要手動編輯。）

---

## 文件

| 路徑 | 內容 |
|---|---|
| `agent-pack/SPEC.md` | AI 必須遵循的 JSON schema 和撰寫規則。 |
| `agent-pack/SPEC-DETAILS.md` | 按需深度閱讀：完整剪貼板匯出／匯入規格、Set/Get 屬性 GUID、動態 pin 欄位說明。只在 SPEC.md 指向這裡時才讀。 |
| `agent-pack/nodes-ue<version>.json` | 依版本切分的完整節點 DB（AI 的字典），例如 `nodes-ue5.7.json`。45K–120K tokens——禁止整檔讀取；請用 index + query.js。 |
| `agent-pack/nodes-ue<version>.index.json` | 自動產生的精簡索引（~12K tokens，可整檔讀取）。列出每個節點的分類、一行描述與旗標。由 `tools/node-t3d-metadata/gen-node-index.js` 產生；CI 與完整 DB 比對把關。 |
| `agent-pack/query.js` | 零依賴查詢 CLI。`node agent-pack/query.js node 5.7 Multiply Lerp` 取得完整 DB 條目；`node agent-pack/query.js mf "<path>"` 取得 MF pin 簽名；`node agent-pack/query.js search 5.7 noise` 關鍵字搜尋。 |
| `agent-pack/nodes-ue<version>.export.json` | 「匯出到 UE」用的每版本 UE 元數據（class 路徑、pin/param/output 對應）。僅供 viewer 使用——撰寫用的 agent 永遠不讀這個。 |
| `agent-pack/examples/` | 參考用 `.matgraph.json` 檔案。 |
| `tools/node-t3d-metadata/` | UE 編輯器 commandlet，從實際 UE 安裝自動擷取並驗證匯出元數據（每個版本各跑一次） — 用法見其 `README.md` / `docs/AGENT_WORKFLOW.md`。 |

---

## 技術棧

TypeScript monorepo（pnpm workspaces）。Viewer 是 React + React Flow + dagre，由一個小型 Node HTTP + WS server 服務，chokidar 監看 `graphs/` 目錄。
