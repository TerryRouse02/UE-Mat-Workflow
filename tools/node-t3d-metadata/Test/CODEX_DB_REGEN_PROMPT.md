# Codex hand-off — regenerate export metadata after the DB augmentation

Paste the block below to the Codex agent on the UE 5.7 machine.

---

在這台 UE 5.7 機器的 `ue-mat-workflow` repo（branch `claude/material-workflow-eval-JOrsQ`）上，我已經把 node discovery 找到的 **158 個缺失引擎節點補進 `agent-pack/nodes-ue5.7.json`**（全部 `verified:false`，pin 名來自反射、型別是 `Float1|2|3|4` 佔位）。現在需要你在 UE 端把 export 元數據補齊並做幾項清理。

**步驟**：

1. `git fetch && git checkout claude/material-workflow-eval-JOrsQ && git pull`

2. **重生成 export 元數據**（會對 `nodes-ue5.7.json` 裡每個節點反射出精確 class path / pin 映射，包含新加的 158 個）：
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 `
     -ProjectPath <你的 .uproject 路徑> `
     -EngineRoot  <你的 UnrealEngine 路徑>
   ```
   若沿用 node discovery 那次的環境問題（DDC / 預設引擎插件），同樣可用最小 host + `-DDC-ForceMemoryCache` + `-NoEnginePlugins -EnablePlugins=UEMatExportMetadata`。新節點在 Engine 模組裡，`-NoEnginePlugins` 不影響。

3. **應用 orphan 修正**（`tools/node-t3d-metadata/db-candidates.json` 的 `orphanFixes` 有列）：
   - 在 `nodes-ue5.7.json` 把 `PreSkinnedLocalNormal` → `PreSkinnedNormal`、`PreSkinnedLocalPosition` → `PreSkinnedPosition`（引擎真正的 class 名；新加的同名節點若已存在就合併，保留 verified 較高者）。
   - 移除 `TextureSampleParameterMovie`（5.7 無對應 class）。
   - `Lerp`、`BlendAngleCorrectedNormals` 保留不動（合法別名 / 引擎 Material Function）。

4. **逐個 spot-check 後把確認過的節點翻成 `verified:true`**。沒把握的維持 `verified:false`（audit 容許 verified:false 落後 export，但 verified:true 必須在 export 裡）。型別 `Float1|2|3|4` 是佔位，順手把明顯的（如 Normal=Float3、純量=Float1）改正。

5. **驗收**（必須全綠）：
   ```
   node tools\node-t3d-metadata\audit-export-meta.js
   node tools\node-t3d-metadata\plugin-src\validate-plugin.js
   pnpm -r test
   ```
   audit 應顯示 `missing=0 orphans=0 unresolved=0 badShape=0 missingMaps=0`。

6. commit（authoring 與 export 兩個檔一起，保持同步）並 push 回同一 branch。

**注意**：
- `nodes-ue5.7.json` 與 `nodes-ue5.7.export.json` 必須一起提交（audit 要求兩半一致）。
- 不要動 viewer 的 `OUTPUTLESS_NODES`（我已加好 18 個 sink；若 regen 後發現還有漏的 output-less 節點報 "no outputs"，再補進那個 set）。

---

## 背景數據（來自上一輪 discovery）

- 引擎 expression 總數 310；補進後 authoring DB = 302（差額是 reserved/abstract/alias，已在生成器 skip）。
- 完整候選與分類在 `tools/node-t3d-metadata/db-candidates.json`（`byCategory`、`outputlessNodes`、`orphanFixes`、`skippedReservedOrAlias`）。
