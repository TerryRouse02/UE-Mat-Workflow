# UE 材質節點 AI 統一工作流 — 設計文件

- 日期：2026-05-26
- 作者：與使用者協作對齊
- 狀態：待審

## 1. 動機與目標

UE5 材質開發者在用 AI 輔助時遇到的痛點：

1. AI 用大段文字描述節點圖，難以閱讀
2. AI 生成的可視化網頁節點亂連、節點名虛構
3. 節點名、pin 名、參數名常常不對齊真實 UE
4. 每次 AI 輸出的格式、樣式不一致

目標：建立一個 **AI 與人共用的標準工作流**，讓 AI 在統一規範下輸出材質節點圖，人類在統一的本地檢視器內查看、瀏覽、可選匯出為單檔 HTML。

**核心定位：這是 AI 輸出 + 人類檢視的工具，不是 UE 材質編輯器的完整複刻。** v1 只做節點連結的視覺化呈現，不做節點編輯、不接 UE 預覽。

## 2. 範圍

### v1 必含

- 依 UE 5.7 真實節點名/pin 名/參數名渲染
- 節點 + 連線 + Comment 註釋框
- 顯示參數值（不可改）
- 自動佈局（dagre）
- Material Function 進入導覽（雙擊 + 麵包屑回退）
- 節點 DB（v1 約 80–150 個常用節點，未列入的也能用但會黃框警示）
- 匯出獨立 HTML
- 跨 CLI AI 整合（Claude Code 為主，Cursor / Gemini CLI / AGENTS.md 通用入口）

### v1 不做

- 節點 / 連線 / 參數的編輯（純檢視）
- 接入 UE 真實預覽
- 貼圖縮圖
- 多 UE 版本切換
- 雲端分享 / 多人同步

## 3. 系統架構

```
┌─────────────────────────────────────────────────────────────┐
│ ue-mat-workflow/                                             │
│                                                              │
│  ┌──────────────────────────┐    ┌──────────────────────┐  │
│  │ agent-pack/  (AI 知識包)  │    │ viewer/  (本地檢視器) │  │
│  │ ├─ SPEC.md                │    │ ├─ server/  Node     │  │
│  │ ├─ nodes-ue5.7.json       │    │ │  ├─ http server   │  │
│  │ ├─ examples/             │    │ │  ├─ chokidar 監控   │  │
│  │ ├─ CLAUDE.md              │    │ │  └─ ws push       │  │
│  │ ├─ AGENTS.md              │    │ ├─ web/ React+Vite   │  │
│  │ └─ .cursorrules          │    │ │  ├─ ReactFlow     │  │
│  └────────┬─────────────────┘    │ │  ├─ dagre         │  │
│           │ AI 讀取                │ │  └─ html exporter │  │
│           │                       │ └─ cli  ue-mat-viewer│  │
│  ┌──────────────────────────┐    └──────────┬───────────┘  │
│  │  graphs/                  │<──────────────┘              │
│  │  └─ *.matgraph.json       │                              │
│  └──────────────────────────┘                              │
│                                              │              │
│                              http://localhost:5790 (瀏覽器)  │
└─────────────────────────────────────────────────────────────┘
```

### 三大元件職責

| 元件 | 職責 | 服務對象 |
|---|---|---|
| **agent-pack/** | 純文件的 AI 規範書 + 節點 DB + 範例 + 各 CLI 入口檔。跨 CLI 通用，不依賴任一私有機制。 | AI |
| **graphs/** | 標準 `*.matgraph.json` 檔案，AI 寫、viewer 讀，是兩端唯一介面。 | 雙方 |
| **viewer/** | 監控 `graphs/`、自動佈局、渲染、提供 HTML 匯出的本地服務。 | 使用者瀏覽器 |

### 跨 CLI 整合

| CLI | 入口檔 |
|---|---|
| Claude Code | `agent-pack/CLAUDE.md`（內容只 @ 引用 `SPEC.md` 與 `nodes-ue5.7.json`） |
| Cursor | `agent-pack/.cursorrules` |
| Gemini CLI | `agent-pack/GEMINI.md` |
| aider / 其他 | `agent-pack/AGENTS.md` |

實際內容只在 `SPEC.md` + `nodes-ue5.7.json` 維護一份。入口檔只負責引用。

### 典型互動流程

1. 使用者在某 CLI 與 AI 對話描述材質需求
2. AI 讀 `SPEC.md` 知規範，讀 `nodes-ue5.7.json` 查可用節點
3. AI `Write` 一份 `graphs/<name>.matgraph.json`
4. viewer 進程偵測檔案變化、解析、自動佈局、WebSocket 推送
5. 瀏覽器即時更新，使用者可進入 MF、可匯出 HTML

## 4. 資料格式 `.matgraph.json`

### 設計原則

1. 一切是節點 — `MaterialOutput`、`FunctionInput`、`FunctionOutput`、`MaterialFunctionCall` 都是節點，連線只認 `node:pin`
2. AI 不寫位置 — 沒有 x/y，dagre 從拓撲推導
3. Material Function 用外部檔引用 — 對應 UE 裡 MF 是 asset 的真實心智

### Schema (Material)

```jsonc
{
  "schemaVersion": "1.0",
  "ueVersion": "5.7",
  "type": "Material",
  "name": "snow_basic",
  "description": "雪地基礎材質（可選）",

  "nodes": [
    {
      "id": "tex1",
      "type": "TextureSampleParameter2D",
      "params": {
        "ParameterName": "BaseColorMap",
        "SamplerType": "Color"
      }
    },
    {
      "id": "mul1",
      "type": "Multiply",
      "params": { "ConstB": 0.8 }
    },
    {
      "id": "mf1",
      "type": "MaterialFunctionCall",
      "params": {
        "MaterialFunction": "./functions/blend_normals.matgraph.json"
      }
    },
    {
      "id": "OUT",
      "type": "MaterialOutput",
      "params": {}
    }
  ],

  "connections": [
    { "from": "tex1:RGB",    "to": "mul1:A" },
    { "from": "mul1:Result", "to": "OUT:BaseColor" },
    { "from": "mf1:Result",  "to": "OUT:Normal" }
  ],

  "comments": [
    {
      "id": "c1",
      "text": "Base Color Tinting",
      "color": "#4a90e2",
      "contains": ["tex1", "mul1"]
    }
  ]
}
```

### Schema (MaterialFunction)

```jsonc
{
  "schemaVersion": "1.0",
  "ueVersion": "5.7",
  "type": "MaterialFunction",
  "name": "blend_normals",
  "nodes": [
    { "id": "in_a",  "type": "FunctionInput",
      "params": { "InputName": "A", "InputType": "VectorFloat3" } },
    { "id": "in_b",  "type": "FunctionInput",
      "params": { "InputName": "B", "InputType": "VectorFloat3" } },
    { "id": "out_r", "type": "FunctionOutput",
      "params": { "OutputName": "Result" } }
    // ... 內部運算節點
  ],
  "connections": [ /* ... */ ]
}
```

`MaterialFunctionCall` 的 pin 不在自己檔內宣告，viewer 載入時去讀目標 MF 檔的 `FunctionInput`/`FunctionOutput` 推導。

### 連線格式

`"from": "<nodeId>:<pinName>"`、`"to": "<nodeId>:<pinName>"`，比物件式短一半且 AI 易寫對。

### 約定路徑

- Material 放 `graphs/` 根
- MaterialFunction 放 `graphs/functions/`
- `MaterialFunctionCall.params.MaterialFunction` 用相對 `graphs/` 根的路徑（如 `"./functions/blend_normals.matgraph.json"`）

## 5. 節點資料庫 `nodes-ue5.7.json`

### 兩層 schema 同檔策略

同一份 JSON 同時服務 AI 與 viewer：

- AI 必查：`nodes[type].inputs[*].name`、`outputs[*].name`
- AI 選查：`params[*]` (要寫常數值才需要)
- AI 可忽略：`category`、`description`、`verified`（給 viewer 與人看的）

`SPEC.md` 會明確告訴 AI 上述分層。

### 條目 schema

```jsonc
{
  "ueVersion": "5.7",
  "generatedAt": "2026-05-26",
  "source": "UE 5.7 docs + UMaterialExpression sources",
  "schemaVersion": "1.0",

  "nodes": {
    "Multiply": {
      "category": "Math",
      "description": "Multiplies two values component-wise.",
      "inputs":  [
        { "name": "A", "type": "Float1|2|3|4", "required": true  },
        { "name": "B", "type": "Float1|2|3|4", "required": false }
      ],
      "outputs": [{ "name": "Result", "type": "matchInput" }],
      "params":  [
        { "name": "ConstA", "type": "Float", "default": 0, "when": "A unconnected" },
        { "name": "ConstB", "type": "Float", "default": 1, "when": "B unconnected" }
      ],
      "verified": true
    }
    // ... 其他節點
  },

  "reservedTypes": ["MaterialOutput", "FunctionInput", "FunctionOutput", "MaterialFunctionCall"]
}
```

### 設計要點

| 設計 | 為什麼 |
|---|---|
| map 結構 (key = 節點名) | O(1) lookup、不可能重複 |
| `type: "Float1\|2\|3\|4"` | UE 的 pin 多態，比強型別更貼真實 |
| `matchInput` 特殊值 | 輸出型別跟最寬輸入走，UE 常見模式 |
| `when: "A unconnected"` | 標明此 param 僅在某 pin 未接時生效 |
| `verified: true\|false` | 標註人工核對狀態；未核對在 viewer 黃框警示 |
| `reservedTypes` | 4 個保留 type 不在 nodes 裡，但 viewer 認得 |

### DB 來源策略

| 階段 | 起始 → 補齊 | 來源 |
|---|---|---|
| v1 (MVP) | 提供完整 schema + ~10 個示範條目（涵蓋 Math/Texture/Coord/Vector）| 使用者依需求網搜 UE 5.7 docs 補到約 80–150 個常用節點 |
| v1.5 | 80–150 → 200+ | PR 補充、`verified: false` 接受社群貢獻 |
| v2 (可選) | 200+ → 完整 | UE Python script 從 editor instance dump 全部 UMaterialExpression |

v1 ship 時的「~10 個範例條目」只是 seed，目的是讓使用者一拉下來就能跑、看到效果；實際工作前要先補到至少覆蓋你常用的節點。

### 防止 AI 亂用節點（兩道防線）

1. **Soft（SPEC.md）**：明確要求 AI 「只能用 `nodes` 裡有的 type」並自查
2. **Hard（viewer）**：載入時掃 `node.type`，不在 `nodes` 也不在 `reservedTypes` → 紅框 + 警告列

## 6. Material Function 導覽

### 載入流程

```
開啟 X.matgraph.json
  ↓
解析 nodes，找所有 MaterialFunctionCall
  ↓
對每個 MFC：
  ├─ 載入指向的 MF 檔
  ├─ 從 FunctionInput  推導 MFC 的 input pin
  ├─ 從 FunctionOutput 推導 MFC 的 output pin
  └─ 把 pin 覆寫到 MFC
  ↓
dagre 自動佈局
  ↓
渲染
```

### 導覽 UX

- 雙擊 MFC 節點 → 原瀏覽器分頁切換到該 MF（push 麵包屑）
- 麵包屑點某段 → 跳回該層
- `Esc` 或瀏覽器返回鍵 → 上一層
- 左側可開合的檔案列表 → 自由切換任何 graph
- URL bar 反映當前層（純 localhost，重整不會跳首頁）

```
┌─────────────────────────────────────────────────────────┐
│  ☰  snow_basic  ▸  blend_normals      [Export .html]    │
├─────────────────────────────────────────────────────────┤
│   [FunctionInput: A]──┐                                 │
│                       ├──[BlendAngleCorrected]─[Out]    │
│   [FunctionInput: B]──┘                                 │
└─────────────────────────────────────────────────────────┘
```

### 錯誤處理

| 情況 | 處理 |
|---|---|
| MF 檔不存在 | MFC 紅框、pin 顯 `?`、警告列：MaterialFunction not found |
| MF 檔 type 不對 | 紅框 + 警告：Expected MaterialFunction |
| 循環引用 | DFS 截斷渲染、警告列指出循環鏈 |
| FunctionInput 缺 InputName | pin 顯 `(unnamed)`、黃框 |

### 快取與熱重載

- 每個 MF 載入後快取在記憶體
- chokidar 偵測到任何 `*.matgraph.json` 變更 → 失效該檔快取 → 向所有用到該檔的圖推送更新

### AI 多檔批次寫入的暫態處理

AI 一次對話常需要寫 Material + 數個 MF，落盤順序不可控。viewer 採用 **300ms debounce** 策略：

- 偵測到任何 `.matgraph.json` 變化後，等 300ms 內不再有新變化才推送
- 若 AI 連續寫 3 個檔，使用者只看到一次更新（不會閃 3 次「MF not found」警告）
- 仍可能出現「Material 寫完但 MF 還沒寫」的中間狀態：可接受，紅框會在 MF 落盤後自動消失

## 7. 技術棧

| 層 | 選型 | 理由 |
|---|---|---|
| 後端 | Node.js (內建 http) + `ws` | 不用 Express 省 ~13 個間接依賴 |
| 檔案監控 | `chokidar` | 跨平台事件穩定 |
| 前端 | Vite + React + TypeScript | 開發體驗與打包都最成熟 |
| 節點圖渲染 | **React Flow** | 社群最大、API 穩、自帶連線/縮放/平移 |
| 自動佈局 | **dagre** | 輕量夠用 |
| Schema 驗證 (dev) | Ajv | 給 DB CI 自查；runtime 不引入 |
| Schema 驗證 (runtime) | 極簡自寫 | 只檢查 type 是否存在、pin 名是否存在，幾十行 |
| HTML 匯出 | Vite 預打包單檔 + 注入當前圖 JSON | 雙擊就能開、無需網路 |
| CLI | Node 腳本 + `process.argv` 解析 | 命令少，不需 commander |

**runtime 依賴**：`ws`、`chokidar`、`react`、`react-dom`、`reactflow`、`dagre` 共 6 個。

### 散播策略（為非開發者使用者）

- 主路徑：`npx ue-mat-viewer start`（要 Node 18+，但無全域安裝）
- 零安裝路徑：用「Export .html」按鈕匯出單檔，雙擊即可在瀏覽器看，不需 Node
- README 清楚寫兩條路徑

## 8. 目錄結構

```
ue-mat-workflow/
├─ agent-pack/
│  ├─ SPEC.md
│  ├─ nodes-ue5.7.json
│  ├─ examples/
│  │  ├─ 01_basic_pbr.matgraph.json
│  │  └─ 02_with_function.matgraph.json
│  ├─ CLAUDE.md
│  ├─ AGENTS.md
│  └─ .cursorrules
│
├─ graphs/
│  ├─ <你的材質>.matgraph.json
│  └─ functions/
│     └─ <你的 MF>.matgraph.json
│
├─ viewer/
│  ├─ package.json
│  ├─ server/
│  │  ├─ index.ts
│  │  └─ html-export.ts
│  ├─ web/
│  │  ├─ src/
│  │  │  ├─ App.tsx
│  │  │  ├─ Graph.tsx
│  │  │  ├─ Breadcrumb.tsx
│  │  │  ├─ nodes/
│  │  │  └─ layout.ts
│  │  └─ vite.config.ts
│  ├─ bin/
│  │  └─ ue-mat-viewer
│  └─ tsconfig.json
│
├─ docs/superpowers/specs/
├─ package.json
├─ pnpm-workspace.yaml
└─ README.md
```

### 啟動方式

```bash
# 一次性
cd ue-mat-workflow
pnpm install
pnpm --filter viewer build

# 開始工作
ue-mat-viewer start                              # 啟服務、瀏覽器自動開 localhost:5790

# 在另一個終端
cd ue-mat-workflow
claude                                            # CLAUDE.md 自動載入、AI 知道規範

# 偶爾用
ue-mat-viewer export snow_basic --out ./out.html
```

`5790` = `5MAT` 諧音，方便記。

## 9. 錯誤處理總原則

**永遠不要因為單一錯誤讓整張圖渲染不出來。** 能畫多少畫多少，問題集中在頂部一條警告列，每條可點跳到出錯節點。

| 層 | 錯誤類型 | 處理 |
|---|---|---|
| AI 寫檔 | JSON 語法錯 | viewer 面板警告 + 顯示 raw 內容；舊圖保留 |
| Schema | 缺欄位 / 型別錯 | 報告路徑；節點/連線跳過繼續渲染 |
| Node DB | 未知 type | 紅框 + 警告列 |
| Node DB | type 對但 pin 名錯 | 該連線變紅、tooltip 顯示原因 |
| MF | 檔不存在 | MFC 紅框、pin 顯 `?` |
| MF | 循環引用 | DFS 截斷、警告列指出循環 |
| Server | port 被佔 | 自動試 5790 → 5791 → 5792 |
| Server | chokidar 失效 | 回退到 polling 模式、警告列提示 |

## 10. 測試策略

| 範圍 | 工具 | 內容 |
|---|---|---|
| Schema 驗證 | Vitest + Ajv | `examples/` 全部正例 + 一組壞掉的反例 |
| DB 載入 | Vitest | DB 格式、無重複 key、verified flag 完整 |
| 佈局 | Vitest | dagre 對固定輸入產生穩定 snapshot |
| MF 載入 | Vitest | 正常 / 缺檔 / 循環 / 3 層深巢狀 四案例 |
| 端對端 (v2) | Playwright (可選) | 寫檔 → WebSocket → DOM 顯示節點正確 |

UI 不寫單元測試（React Flow + dagre 都是第三方，自家邏輯薄）。E2E v1 不做，留到 v2 視需求。

## 11. 非目標（明確排除以免範圍漂移）

- 不做 UE 真實預覽（不接 UE Editor）
- 不做節點 / 連線 / 參數的編輯（純檢視）
- 不做貼圖縮圖顯示
- 不做多 UE 版本同時切換
- 不做雲端分享 / 多人同步
- 不做 AI 增量編輯 API（AI 一次寫整檔）

## 12. v1 交付 checklist

- [ ] `agent-pack/SPEC.md` 寫好（AI 規範書）
- [ ] `agent-pack/nodes-ue5.7.json` 含 stub 結構 + 10 個範例條目 + 待補清單
- [ ] `agent-pack/examples/` 至少 2 個範例 graph（純 Material、Material + MF）
- [ ] `agent-pack/CLAUDE.md` / `AGENTS.md` / `.cursorrules` 入口檔
- [ ] viewer：node http server + ws + chokidar + 錯誤處理
- [ ] viewer：React + ReactFlow + dagre 渲染 + 麵包屑
- [ ] viewer：HTML 匯出按鈕
- [ ] CLI：`ue-mat-viewer start` / `export`
- [ ] Vitest 覆蓋 §10 列的單元測試
- [ ] README 寫清兩條散播路徑
