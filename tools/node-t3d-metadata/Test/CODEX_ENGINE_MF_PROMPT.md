# Codex hand-off — build the official engine-MF index on the UE 5.7 machine

Paste the block below to the Codex agent running on the UE 5.7 machine.

---

在這台 UE 5.7 機器的 `ue-mat-workflow` repo 上，我新增了一個**官方 Material Function 索引模式（Engine MF）**（branch `claude/material-workflow-eval-JOrsQ`）。請幫我執行並**提交**產出的索引。

**背景**：node DB 只涵蓋內建**表達式**（C++ class）。官方的內建 **Material Functions**（`/Engine/Functions/**` 那一整套，像 `CustomRotator`、`BumpOffset_Advanced`）是引擎隨附的 `.uasset`，不是表達式 class，所以 DB 和 node-discovery 都看不到它們。結果：真實材質呼叫到官方 MF 時，pin 對不上 —— 匯出時每個 `FunctionInputs(n)` 全擠到 index 0，貼回 UE 線就斷。

這個模式就是把現有的 **WorkMF 爬蟲**指向 `/Engine/Functions`（同一支 commandlet、同一種輸出格式），差別只在輸出是**要提交進 repo 的**（官方庫是穩定的隨附資料，所有使用者共用），不像 WorkMF 的 `/Game` 索引是 gitignored。

**步驟**：

1. `git fetch && git checkout claude/material-workflow-eval-JOrsQ && git pull`

2. 跑 Engine MF 爬取（`-ProjectPath` **可省略** —— 爬的是 `/Engine` 資產，跟專案無關，省略時會用內建的最小 host project；它也會在 plugin-src 比 compiled 新時自動重新打包）：
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Run-EngineMfIndex.ps1 `
     -EngineRoot <你的 UnrealEngine 路徑>
   ```
   （預設爬 `/Engine/Functions`，寫到 `agent-pack\enginemf-index-ue5.7.json`。若你還依賴某些**插件**提供的 MF，可加 `-ContentRoots "/Engine/Functions,/你的插件"`。）

3. **編譯可能撞到版本敏感點** —— 沒有新增 C++，但這條路徑用的是既有 WorkMF 程式碼裡的 `UMaterialFunction::GetInputsAndOutputs`、`FFunctionExpressionInput/Output`、`UMaterialExpressionFunctionInput::InputName/InputType`、`SortPriority`。如果某個簽名在裝的 5.7 header 上不同，按實際 header 修正（這些點在 `UEMatExportMetadataCommandlet.cpp` 裡都標了「API NOTE」）。

4. 確認 commandlet log 出現（N 應該是**幾百個**）：
   ```
   Wrote work-MF index: ...\agent-pack\enginemf-index-ue5.7.json (N function(s), 0 load failure(s))
   ```
   注意：本機 DDC/Zen 的尾端摘要可能讓 UnrealEditor 回非零退出碼 —— 只要索引有寫出、log 有上面那行，runner 會當成「成功但有 warnings」，不是失敗。

5. 快速驗證消費端能讀（純本機，不用 UE；先 build 一次 viewer 或用已 build 的 dist）：
   ```bash
   node -e "const{loadWorkMfIndex}=require('./viewer/dist/server/workmf-index.js');loadWorkMfIndex('agent-pack/enginemf-index-ue5.7.json').then(r=>console.log(r.warnings.length?r.warnings:'ok',Object.keys(r.index?.functions||{}).length+' functions'))"
   ```

6. **提交這份索引**（這份跟 WorkMF 不同，是要進 repo 的）：
   ```bash
   git add agent-pack/enginemf-index-ue5.7.json
   git commit -m "Populate official engine Material Function index (UE 5.7)"
   git push
   ```
   然後把 commandlet log 的那行（N 是多少）回報給我即可。

補充：這跟 node-discovery 不同 —— discovery 是反射枚舉 C++ 表達式 class；Engine MF 是用 AssetRegistry 掃 `/Engine/Functions` 的 MF **資產**。詳細說明、schema、guardrails 在 `tools/node-t3d-metadata/docs/ENGINE_MF.md`。

---

## 預期產物

`agent-pack/enginemf-index-ue5.7.json`（取代目前的 placeholder `functions: {}`），形如：

```jsonc
{
  "schemaVersion": "1.0",
  "kind": "workmf-index",
  "ueVersion": "5.7",
  "provenance": { "contentRoots": "/Engine/Functions", "engineVersion": "5.7.4-...", ... },
  "functions": {
    "/Engine/Functions/Engine_MaterialFunctions02/Texturing/CustomRotator.CustomRotator": {
      "assetPath": "/Engine/Functions/Engine_MaterialFunctions02/Texturing/CustomRotator.CustomRotator",
      "displayName": "CustomRotator",
      "inputs":  [ { "name": "UVs", "type": "Float2", "index": 0 }, ... ],
      "outputs": [ { "name": "Result", "type": "Float3", "index": 0 } ],
      "missing": false
    }
  }
}
```

`Test.txt` 裡撞到的 `/Engine/Functions/Engine_MaterialFunctions02/Texturing/CustomRotator`
和 `.../Utility/BumpOffset_Advanced` 應該都會出現在 `functions` 裡。提交後，那個材質的官方
MF 就能無損進出了。
