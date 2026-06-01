# Spec — 工作專案 MF 索引 + UE 節點爬取工具產品化

狀態：Phase 1（純 TS 消費端）完成、測試全綠（vitest 133/133、tsc 0 errors）；Phase 2-4 待 Windows/UE 機（Codex）。
開發機：macOS（Darwin），**無 UE / 無 PowerShell** → 只有 Phase 1（純 TS）能在本機驗證；Phase 2-4 屬 Windows/UE，於本機僅「盲寫」，須在 UE 機（Codex 端）驗證。

本 spec 分階段。**Phase 1 必須在沒有 UE 的環境也能完整跑綠**，後續階段不得混入 Phase 1。

---

## 三條認知修正（先看，避免重造輪子 / 製造回歸）

1. **asset-path MFC 的「導出」已完成且有測試。** `ueT3D.ts:140-145`（asset path 原樣輸出）、`:490-499`（emit `MaterialFunction'…'`）、`:214-217`（MFC 用 derivedPins）、`:147-161`（`FunctionInputs(n)`）。`ueT3D.test.ts:437` 已綠。**唯一真正缺口**：`mf-resolver.ts` 只讀 `.matgraph.json`（`:26,:32,:38`），對 `/Game/…` asset path 沒有 pin 來源。**Phase 1 = 補這個來源，不重寫 exporter。**
2. **絕不動 `dbRegistry.ts` 的 build-time glob。** `:25` 的 `import.meta.glob('…/nodes-ue*.json')` 在 build 時掃所有 `nodes-ue*.json` 並用 `ueVersion` 當 key（`:32-46`）。故本地索引檔**命名不得以 `nodes-ue` 開頭**、**不得經 dbRegistry 載入**（會被烤進 `html-export` 單檔，洩漏工作專案路徑）。一律**走 server runtime**。
3. **preflight / 退出碼檢查現有腳本已有。** `Invoke-NodeT3DMetadataMaintenance.ps1:78-91`、`:48-54`。後續階段沿用，勿重造。

## 硬約束（全程）

- 不把任何工作專案路徑 / 資產 / MF 資料提交進 git。
- 不改 host `.uproject`、不複製插件進工作專案 `Plugins/`；續用 external packaged plugin。
- 任何 commandlet / node / vitest / audit 失敗都檢查退出碼，不吞錯。
- 生成 JSON 一律 **UTF-8 without BOM**。
- 不手寫猜測 UE pin 映射；能由 reflection / commandlet 抓的都用 commandlet。
- 保留 `nodes-ue5.7.json` / `nodes-ue5.7.export.json` 行為；`export-meta.test.ts:11` 斷言 `ueVersion==="5.7"`，新增 provenance 不得破壞。
- 本地索引檔命名不得以 `nodes-ue` 開頭、不得進 build bundle、必須 gitignore。

---

## 資料契約

兩個**本地 only、gitignored** 檔案，置 `agent-pack/`，命名刻意避開 `nodes-ue*`。

### `agent-pack/workmf-index.json`（預覽 + **agent 撰寫**側）

```jsonc
{
  "schemaVersion": "1.0",
  "kind": "workmf-index",          // loader 必須斷言此值，杜絕被當成 NodeDB
  "ueVersion": "5.7",              // 僅溯源/路由標籤；匹配靠 assetPath，不做版本門檻
  "provenance": { /* 見 Phase 2；Phase 1 fixture 可填佔位 */ },
  "functions": {
    "/Game/Functions/MF_Foo.MF_Foo": {
      "assetPath": "/Game/Functions/MF_Foo.MF_Foo",
      "displayName": "MF_Foo",
      "category": "Project/Foo",
      "packagePath": "/Game/Functions/MF_Foo",
      "inputs":  [ { "name": "UV", "type": "Float2", "index": 0, "default": null } ],
      "outputs": [ { "name": "Result", "type": "Float3", "index": 0 } ],
      "packageTimestamp": null, "hash": null, "missing": false
    }
  }
}
```

- `inputs` 必須按 UE FunctionInput 的 SortPriority / 宣告順序排列，`index` 顯式寫出。exporter 既有定位邏輯（`ueT3D.ts:155-160`）靠這個順序算 `FunctionInputs(n)`，故順序即正確性。

### `agent-pack/workmf-index.export.json`（emitter 側；Phase 1 只定 schema + fixture，消費/生成留 Phase 2）

```jsonc
{
  "schemaVersion": "1.0", "kind": "workmf-export", "ueVersion": "5.7",
  "provenance": { /* 見 Phase 2 */ },
  "functions": {
    "/Game/Functions/MF_Foo.MF_Foo": {
      "ueClass": "/Script/Engine.MaterialExpressionMaterialFunctionCall",
      "functionRefProperty": "MaterialFunction",
      "functionAsset": "/Game/Functions/MF_Foo.MF_Foo",
      "inputs":  { "UV": { "property": "FunctionInputs(0)" } },
      "outputs": { "Result": { "index": 0 } },
      "verified": true
    }
  }
}
```

---

## workmf-index 的三個消費者（含 agent）

1. **viewer/server（mf-resolver）** → 渲染 pin（Phase 1）。
2. **exporter（ueT3D）** → 已完成，靠 derivedPins，不改。
3. **AI agent（Claude / Codex）本身** → 這是使用者最在意的用途。當 agent 在**優化「使用者自己工作專案」內的材質**、且該材質呼叫**使用者自建的 MF**（使用者在自己 UE 專案裡做的 Material Function，以 UE asset path 引用，如 `/Game/Functions/MF_Foo.MF_Foo`；**不是**官方/引擎 MF）時，agent 必須能讀到該 MF 的**精確 input/output pin 名與型別**，才能寫出正確的 `connections`。`nodes-ue5.7.json` 只含官方內建節點，**不含使用者自建 MF**；`workmf-index.json` 就是補這塊：**使用者自建專案 MF 的字典**（由 agent 讀取消費，agent 不擁有它；官方/引擎 MF 不收錄）。

### Agent 契約（Phase 1 一併落地，更新 `agent-pack/SPEC.md`、`CLAUDE.md`、`AGENTS.md`、`GEMINI.md`、`.cursorrules`）

> 當材質呼叫**使用者自建的 MF**（以 UE asset path `/…` 引用，非 `./…matgraph.json`）：
> 1. 先在 `agent-pack/workmf-index.json` 的 `functions[<assetPath>]` 查該 MF。
> 2. 用其 `inputs[].name` / `outputs[].name` 寫 `connections`（pin 名精確匹配，與內建節點同規則）。
> 3. 查不到 → **停下並請使用者先跑 WorkMF discover**（見 Phase 2），不要臆造 pin 名。
> 4. `/Engine/…` 引擎內建 MF 不在此索引、viewer 不可預覽，但導出可解析（保留現狀）。

---

## Phase 1 — 純 TypeScript，本機完整可驗證（先做）

目標：viewer + agent 對「asset-path MaterialFunctionCall」不再缺 pin；既有 exporter 不改一行即正確輸出。

1. 新增 `viewer/server/workmf-index.ts`：runtime 載入並快取 `agent-pack/workmf-index.json`（路徑可由 config 覆寫）。缺檔 → 空索引、不丟錯；JSON/`kind` 不合法 → warning + 空索引。
2. 改 `viewer/server/mf-resolver.ts`，對每個 MFC 的 `params.MaterialFunction` 分類：
   - 結尾 `.matgraph.json`（或非 `/` 開頭）→ **維持現有行為**。
   - `/Game/…` → 查 workmf-index：命中 → 依序 derivedPins；未命中 → warning（`work MF not in index: <path>（請跑 WorkMF discover）`）+ 空 pins。
   - `/Engine/…` → info（非 error）+ 空 pins（順帶修掉目前對 engine path 誤報 not found）。
3. **不動** `ueT3D.ts`、`dbRegistry.ts`。
4. 更新 agent 規則檔（上節 Agent 契約）。
5. `.gitignore` 加入 `agent-pack/workmf-index.json`、`agent-pack/workmf-index.export.json`、`tools/node-t3d-metadata/local.config.json`。
6. 提供 `agent-pack/workmf-index.example.json`（提交，給人對照 schema；非真實資產）。

測試（先寫失敗再實作）：
- `viewer/tests/mf-resolver.test.ts`：① `/Game/…` 命中 index → 依序 derivedPins；② 未命中 → warning + 空；③ 相對 `.matgraph.json` 不回歸；④ circular 不回歸；⑤ `/Engine/…` → 非 error。
- `viewer/tests/workmf-index.test.ts`（新）：合法 fixture 載入；缺檔 → 空且不丟錯；壞 JSON / 錯 `kind` → 清楚 warning。
- `viewer/tests/ueT3D.test.ts`：新增回歸鎖——asset-path MFC + index 來的 derivedPins → 輸出含 `MaterialFunction'"/Game/…"'` 與按接線順序的 `FunctionInputs(n)`（證明 exporter 無需改）。
- gitignore 守門（node 測試或腳本，用 `git check-ignore`）。

Phase 1 驗收（本機必須全綠）：
```
viewer/node_modules/.bin/vitest run viewer/tests/mf-resolver.test.ts viewer/tests/ueT3D.test.ts viewer/tests/export-meta.test.ts viewer/tests/workmf-index.test.ts
node tools/node-t3d-metadata/audit-export-meta.js
git check-ignore agent-pack/workmf-index.json agent-pack/workmf-index.export.json tools/node-t3d-metadata/local.config.json
```

---

## Phase 2 — UE-gated：commandlet 生成索引 + provenance（Windows/UE 機驗證）

1. commandlet 新增 `WorkMF` 模式，掃 `UMaterialFunction(Interface)`，從 config `workMfScanRoots`（如 `/Game`）：
   - `-WorkMFDiscoverRoots /Game/Project,/Game/Shared`：生成兩個 index 檔。
   - `-WorkMFUpdateExisting`：只刷新已存在 assetPath 的 pin 簽名。
   - 缺失資產 → 標記 `missing:true` + warning，不刪；只有 `-PruneMissing` 才刪。
2. **provenance**（寫入 `*.export.json` 與 workmf 兩檔），**全部由 UE runtime API 取得，禁止 hardcode**（`FEngineVersion::Current()`/`::CompatibleWith()`、`FApp::GetBuildVersion()`）：
   ```jsonc
   "provenance": {
     "ueVersion": "5.7",
     "engineReleaseVersion": "5.7.4",
     "engineVersion": "5.7.4-51494982+++UE5+Release-5.7",
     "compatibleEngineVersion": "5.7.0-...",
     "changelist": 51494982, "engineRoot": "...",
     "generatedBy": "UEMatExportMetadata", "commandletVersion": "...",
     "pluginHash": "...", "generatedAt": "<ISO8601>"
   }
   ```
   `nodes-ue5.7.export.json` 頂層加 `provenance`，但 `ueVersion` 維持 `"5.7"`（守 `export-meta.test.ts:11`）。
3. preflight 增補：vitest.cmd 存在性、UE major.minor 與目標 nodes 檔匹配。

## Phase 3 — 統一入口 + summary + config（沿用現有模式）

1. 新增 `Invoke-UEMatWorkflowMaintenance.ps1`：`-Mode Metadata|CaptureNode|CaptureFixtures|WorkMF|All`、`-UEVersion auto`、`-ValidationMode Quick|Full`、`-SummaryJson`。複用現有 preflight 與 `Invoke-External` 退出碼模式；舊 `Invoke-NodeT3DMetadataMaintenance.ps1` 改薄 shim 轉呼 `-Mode Metadata`。
2. config：`local.config.example.json`（提交）+ `local.config.json`（gitignored）。鍵：`projectPath/engineRoot/defaultTextureAsset/workMfScanRoots/workMfOutputIndex/workMfOutputExport/validationMode`。優先序：顯式參數 > local.config.json > 環境變數；缺失 → 明確錯誤、不靜默 fallback。
3. 控制台精簡（step/exit code/warn-err 數/關鍵產物路徑）；完整 UE log 入 `Logs/UE`；另出穩定結構 summary JSON。

## Phase 4 — 之後（勿碰既有已驗證管線）

- recipe 化只做 1-2 節點 PoC，不重構 commandlet 既有 override TMaps（`…Commandlet.cpp:47-157`）與 NamedReroute 擷取（`:653-766`）。
- 多版本 loader：無精確版本時選最近相容版 + warning（dbRegistry 已按 `ueVersion` 配對，此為加法）。

---

## 交付物

- 代碼改動摘要（按 Phase）。
- 新增命令用法。
- 兩個 index 檔 schema 示例 + provenance 示例（含真實 5.7.4 build，但路由仍 5.7）。
- `git status`、驗收命令結果（Phase 1 全綠是硬門檻；Phase 2/3 無 UE 則說明阻塞點，但 Node/Vitest 必綠）。

## 不要做

- ❌ 改 `dbRegistry.ts` glob、或讓本地索引以 `nodes-ue` 開頭 / 進 build bundle。
- ❌ 為 asset-path 導出去重寫 `ueT3D.ts`（已完成，只加回歸測試）。
- ❌ 把 Phase 2/3/4 塞進 Phase 1。
- ❌ hardcode provenance、靜默 fallback、吞退出碼。
