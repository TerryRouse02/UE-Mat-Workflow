# UE Material Workflow

AI 與人協作 UE 5.7 材質節點圖的統一工作流。AI 輸出標準 `.matgraph.json` 格式，本地 viewer 即時呈現節點圖，忠實還原 UE 表達式樣貌。

[English](./README.md)

---

## 為什麼用這套

- **不要再用文字牆描述節點圖了。** AI 用嚴格 JSON schema 描述材質，viewer 渲染成像真的 UE 節點。
- **不要再讓 AI 亂編節點名了。** 釘住的 UE 5.7 節點 DB（142 個 expression）是 single source of truth——AI 必須用已存在的節點型別、精確的 pin 名稱、精確的 param 名稱。
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

Sidebar 有兩個 tab：

| Tab | 內容 |
|---|---|
| **Files** | 你的材質，依專案資料夾分組。`graphs/<project>/` 內若恰有 1 個 Material + 它使用的 MF，就是一個專案；其他結構不符的會顯示在「Unorganized」區。 |
| **Nodes** | UE 5.7 完整節點庫——可依名稱或描述搜尋、按分類瀏覽，點節點看 inputs / outputs / params 細節，包含型別與徽章（verified、dynamic-pin、deprecated）。 |

檔案變動時 viewer 會自動 reload。

---

## 搭配 AI 工具使用

`agent-pack/` 目錄裡有 spec、node DB、範例，以及給各主流 AI 工具的規則檔。把工具指向這個 repo 就能開始下 prompt。

### Claude Code

`agent-pack/CLAUDE.md` 會被自動讀取。在這個 repo 的任何對話裡：

> 「幫我做一個風格化水材質，加上 normal map 扭曲和 fresnel 邊緣輝光。」

Claude 會讀 `SPEC.md`、從 `nodes-ue5.7.json` 挑節點型別、把 JSON 寫到 `graphs/<project>/`。Viewer 立刻渲染。

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

## 範例

`agent-pack/examples/` 有舊扁平結構的參考檔。要套用新慣例：

```bash
mkdir -p graphs/basic_pbr graphs/with_function
cp agent-pack/examples/01_basic_pbr.matgraph.json graphs/basic_pbr/
cp agent-pack/examples/02_with_function.matgraph.json graphs/with_function/
cp agent-pack/examples/functions/blend_normals.matgraph.json graphs/with_function/
```

接著編輯 `with_function/02_with_function.matgraph.json`，把 MaterialFunction 路徑從 `"./functions/blend_normals.matgraph.json"` 改成 `"./blend_normals.matgraph.json"`。

---

## 補充節點 DB

`agent-pack/nodes-ue5.7.json` 目前有 142 個 expression。要新增：

1. 從 [UE Material Expression Reference](https://dev.epicgames.com/documentation/en-us/unreal-engine/material-expression-reference) 查節點。
2. 仿照現有條目格式新增到 `nodes.<NodeName>`（inputs、outputs、params、category、description）。
3. `verified: true` 只在你親自核對過後才設。
4. 跑 `pnpm test` 確認 DB 仍合法。

---

## 文件

| 路徑 | 內容 |
|---|---|
| `agent-pack/SPEC.md` | AI 必須遵循的 JSON schema 和撰寫規則。 |
| `agent-pack/nodes-ue5.7.json` | UE 5.7 節點 DB（AI 的字典）。 |
| `agent-pack/examples/` | 參考用 `.matgraph.json` 檔案。 |
| `docs/superpowers/specs/` | 功能 spec（設計決策）。 |
| `docs/superpowers/plans/` | 實作計劃（歷史記錄）。 |

---

## 技術棧

TypeScript monorepo（pnpm workspaces）。Viewer 是 React + React Flow + dagre，由一個小型 Node HTTP + WS server 服務，chokidar 監看 `graphs/` 目錄。
