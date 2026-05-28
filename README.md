# UE Material Workflow

AI 與人協作 UE5.7 材質節點圖的統一工作流。AI 寫 `.matgraph.json` 標準格式檔，本地 viewer 即時呈現節點圖。

## 安裝

```bash
git clone <repo>
cd ue-mat-workflow
pnpm install
pnpm build
```

需要 Node 18+ 和 pnpm。若沒裝 pnpm，可用 `npx pnpm install` 代替。

## 使用

啟動 viewer：

```bash
pnpm start
# → http://localhost:5790 (自動嘗試 5790-5799)
```

在另一個 terminal 跟你的 AI 對話（Claude Code 等），AI 會根據 `agent-pack/SPEC.md` 把材質寫到 `graphs/<project>/<name>.matgraph.json`，瀏覽器自動更新。

Sidebar 介紹：
- **Files tab**：每個 `graphs/<project>/` 是一個專案（恰好 1 個 Material + 它使用的 MF），可摺疊；散落的舊檔或結構不符的會顯示在 Unorganized 區
- **Nodes tab**：搜尋 + 分類瀏覽完整節點庫（UE 5.7，142 nodes），點節點看 inputs/outputs/params 細節

匯出獨立 HTML（可離線、可分享給沒有 Node 的人）：

```bash
node viewer/dist/server/html-export.js export 01_basic_pbr --out ./my-graph.html
```

## 給非 Node 使用者

如果只是想看別人匯出的圖，雙擊 `.html` 即可，不需安裝任何東西。

## 範例

`agent-pack/examples/` 下有兩個範例：

- `01_basic_pbr.matgraph.json` — 純 Material
- `02_with_function.matgraph.json` — 含 MaterialFunction

把它們複製到自己的專案資料夾（範例採用舊扁平結構，新建議是 `graphs/<project>/`）：

```bash
mkdir -p graphs/basic_pbr graphs/with_function
cp agent-pack/examples/01_basic_pbr.matgraph.json graphs/basic_pbr/
cp agent-pack/examples/02_with_function.matgraph.json graphs/with_function/
cp agent-pack/examples/functions/blend_normals.matgraph.json graphs/with_function/
```

然後把 `with_function` 的 `params.MaterialFunction` 從 `"./functions/blend_normals.matgraph.json"` 改成 `"./blend_normals.matgraph.json"`。

## 設計與規格

- 設計文件：`docs/superpowers/specs/2026-05-26-ue-material-workflow-design.md`
- 實作計劃：`docs/superpowers/plans/2026-05-26-ue-material-workflow.md`
- AI 規範：`agent-pack/SPEC.md`
- 節點 DB：`agent-pack/nodes-ue5.7.json`（v1 seed，需補充）

## 補充節點 DB

DB 內目前有 10 個示範條目。補充時：

1. 從 https://dev.epicgames.com/documentation/en-us/unreal-engine/material-expression-reference 查節點
2. 仿造現有條目格式新增到 `nodes.<NodeName>`
3. 確認 `verified: true`（你親自核對過）
4. 跑 `pnpm test` 確認 DB 仍合法
