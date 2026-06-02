# Codex hand-off — run node discovery on the UE 5.7 machine

Paste the block below to the Codex agent running on the UE 5.7 machine.

---

在這台 UE 5.7 機器的 `ue-mat-workflow` repo 上，我新增了一個**節點發現模式（node
discovery）**的 commandlet 功能（branch `claude/material-workflow-eval-JOrsQ`）。請幫我編譯、執行、回報結果。

**背景**：authoring DB `agent-pack/nodes-ue5.7.json` 只有 144 個手寫節點，commandlet 以前只會「照清單填細節」，不會發現引擎裡清單外的節點。新模式用反射 `GetDerivedClasses(UMaterialExpression::StaticClass(), ...)` 枚舉**全部** material expression 子類，跟 DB 比對，輸出缺口報告。

**步驟**：

1. `git fetch && git checkout claude/material-workflow-eval-JOrsQ && git pull`

2. 跑發現模式（它會在 plugin-src 比 compiled 新時自動重新打包插件）：
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Run-NodeDiscovery.ps1 `
     -ProjectPath <你的 .uproject 路徑> `
     -EngineRoot  <你的 UnrealEngine 路徑>
   ```
   （預設用 `agent-pack\nodes-ue5.7.json` 做 diff，報告寫到 `tools\node-t3d-metadata\node-discovery.json`。）

3. **編譯可能撞到版本敏感點** —— 新代碼在 `UEMatExportMetadataCommandlet.cpp` 的 `WriteNodeDiscovery` 函數，用了這些 editor-only 反射 API：`GetDerivedClasses`、`UMaterialExpression::GetInput(i)` / `GetInputName(i)` / `GetOutputs()`（回傳 `TArray<FExpressionOutput>`，取 `.OutputName`）、`GetCaption(TArray<FString>&)`、class flags `CLASS_Abstract` / `CLASS_Deprecated` / `CLASS_NewerVersionExists`。如果某個簽名在裝的 5.7 header 上不同，就按實際 header 修正（這些 API 跟既有 metadata 路徑用的是同一組，參考同檔的 `BuildDisplayInputMap` / `BuildOutputsObject` 怎麼呼叫）。

4. 確認 commandlet log 出現：
   ```
   Wrote node discovery report: ...node-discovery.json (N engine expressions, 144 in DB, M missing, D deprecated, O orphans)
   ```

5. **把 `node-discovery.json` 的內容貼回來給我**（特別是 `counts` 和 `missing[]` 陣列），讓我看引擎到底有多少節點、我們缺哪些。先**不要**改 `nodes-ue5.7.json`，等我看完報告再決定補哪些。

補充：這跟 WorkMF 不同 —— WorkMF 是掃 `/Game` 目錄的 MF **資產**，發現模式是反射枚舉編譯進引擎的 **C++ 類別**，不需要指目錄。詳細說明在 `tools/node-t3d-metadata/docs/NODE_DISCOVERY.md`。

---

## 預期產物

`tools/node-t3d-metadata/node-discovery.json`，形如：

```jsonc
{
  "kind": "node-discovery",
  "engineVersion": "5.7.4-...",
  "counts": { "engineExpressions": 0, "inDb": 144, "missing": 0, "deprecated": 0, "orphansInDb": 0 },
  "missing": [
    { "type": "RuntimeVirtualTextureOutput",
      "ueClass": "/Script/Engine.MaterialExpressionRuntimeVirtualTextureOutput",
      "caption": "Runtime Virtual Texture Output",
      "inputs": ["BaseColor", "Specular", "Roughness", "Normal", "WorldHeight", "Opacity", "Mask"],
      "outputs": [] }
  ],
  "deprecated": ["..."],
  "orphansInDb": ["..."]
}
```

`Test.txt` 裡撞到的 `RuntimeVirtualTextureOutput`、`MeshPaintTextureObject`、
`MeshPaintTextureReplace` 應該會出現在 `missing[]`。
