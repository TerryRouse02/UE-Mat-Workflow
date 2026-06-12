# 內置材質 Agent — 實作契約 v0.2

把一個面向**完全不懂材質的使用者**、能生成 / debug / 修改 UE 材質的對話式 agent
內置進現有 viewer。本文件是實作契約：照里程碑由上而下做，每個里程碑有驗收標準。
識別字 / 介面用英文，說明用中文。

> v0.2 = 原始藍圖（agent-design.html, v0.1）＋ 2026-06-10 對齊後的九條修正案。
> 所有整合點與數據均已對照程式碼核實，不需重新驗證。

---

## 0. 範圍與核心原則

- `validateGraph` 只證明**結構合法**，不證明**語意正確**。使用者用眼睛驗收，
  所以閉環驗證是地基、接地迴圈（即時圖＋白話 diff＋undo）才是價值。
- **MVP = M0–M5**。範圍外（觀察/後做）：真實材質渲染預覽、UE 貼入 T3D debug、
  第三方 native adapter、JSON-in-text 工具降級解析。
  - 評測語料已落地（2026-06-11）：`tests/eval/`（情境 DSL＋fixtures＋runner，含
    memory／compact／discovery 類別與 sessionMemoryIncludes 期望）＋
    `tests/agent-eval.test.ts`，27 個腳本化情境涵蓋生成／修圖／自修／undo／記憶／壓縮／探索／檢視器動作，見 §10。
- Local-first 鐵律不變：零新 npm 依賴（Node 18+ 原生 fetch）、零額外部署、
  一鍵 `pnpm dev`。
- **現況（2026-06-11 收尾）**：M0–M5 全數落地，並完成後續批次——持久會話＋兩層記憶＋
  自動/手動壓縮（M7/M7b/M11-1）、思考串流、檔案管理／剪貼簿／爬取提案／DB 修改提案
  ／公網存取／爬取 log／視窗情境查詢 共 24 工具、畫布變更高亮、問 AI／匯入後解說入口、
  系統回報卡＋爬取結果回流、斜槽快捷指令（11 個）、會話 Markdown 匯出、每輪用量顯示、
  Agent 分頁 keep-alive＋注意力小點、聊天欄寬度拖曳。功能快照見 §12。

## 1. 整合點（已核實，含證據位置）

| 既有檔 | 角色 | 怎麼用 |
|---|---|---|
| `server/schema.ts` | `validateGraph`（matgraph 契約）＋ `materialStructureWarnings`（語意警告） | 寫入類工具落盤前強制呼叫，**警告也要回進 tool_result** |
| `server/mf-resolver.ts` | `resolveMaterialFunctions` 解析 MF 針腳 | 驗證流程一部分（回報未解析針腳） |
| `server/graph-loader.ts` | `loadGraph` 讀＋解析＋驗證 | `read_graph` 底層 |
| `agent-pack/query.js` → 拆出 `query-lib.js` | 節點/MF 查詢邏輯（現為 CLI-only，無 exports） | server 工具與 CLI 共用同一查詢實作（SSoT） |
| `agent-pack/nodes-ue<v>.json` ＋ `.index.json` | node DB | `search_nodes` / `get_node_signature` 資料源 |
| `agent-pack/SPEC.md` | matgraph 撰寫規則（瘦身後 11.6KB ≈ 3K tokens） | **整份**讀入 system prompt（runtime 從磁碟讀，不烤死） |
| `server/http-server.ts` | 路由 + `sameOrigin()` (≈line 216) + loopback bind | 掛 `/api/agent/*`，全部 POST 過同源檢查 |
| `server/watcher.ts` | chokidar 監看 `graphs/`，**只認 `.matgraph.json` 後綴**（line 39） | agent 寫檔自動觸發重繪，免自建推送 |
| `tools/node-t3d-metadata/local.config.json` | 每機組態（已 gitignored） | 新增 `Llm` 欄位存 provider/key。**已核實 `crawl-env.ts:35` 只解構 ProjectPath/EngineRoot，任何既有端點都不會回流未知欄位** |

關鍵事實（決策依據，勿重查）：
- **verified 覆蓋**：296 節點中 140 verified，但已逐類核實 **100% 覆蓋日常詞彙**
  （Math 41/41、Constants 19/19、Coordinates 17/17、主力貼圖採樣器、Fresnel/Noise 等）。
  156 個未驗證全在冷門區（Substrate 22、RVT/稀疏體積貼圖 25、平台開關等）。
  7 個 shipped examples 零未驗證節點。
- **schema 真實形狀**（`server/types.ts`）：頂層 `schemaVersion/ueVersion/type/name/nodes/connections`
  ＋可選 `description/comments`；node = `{id, type, params?}`；connection =
  `{from: "nodeId:pinName", to: "nodeId:pinName"}`；id 不得含 `:`。
- **checkpoint 位置**：`graphs/.checkpoints/` 有誤 commit 風險（graphs/ 的 gitignore
  只蓋 `.matgraph.json`），故用 `viewer/.agent-checkpoints/`（加 .gitignore 一行）。

## 2. 新增模組佈局

```
viewer/
├─ server/
│  ├─ http-server.ts            # 掛 /api/agent/* 端點（改）
│  └─ agent/                    # 全新模組
│     ├─ provider/types.ts      # 中性型別 = SSoT，loop 只認這套
│     ├─ provider/sse.ts        # 零依賴 SSE 解析器
│     ├─ provider/anthropic.ts  # Messages API 原生 adapter
│     ├─ provider/openai.ts     # OpenAI-compatible adapter（可配 baseUrl）
│     ├─ provider/index.ts      # pickProvider(config)
│     ├─ loop.ts                # agent loop（閉環＋護欄＋連續失敗熔斷）
│     ├─ tools.ts               # 24 個 tool 定義 + dispatch（探索/視窗情境/記憶/壓縮/檔案管理/剪貼簿/爬取提案/DB 修改提案/公網/爬取 log）
│     ├─ pin-validate.ts        # 寫入閘門的連線針腳檢查（鏡像 web/src/validate.ts 語意）
│     ├─ db-edit.ts              # 節點 DB 修改的驗證＋套用（重生索引＋audit，失敗回滾）
│     ├─ patch.ts               # patch_graph 領域操作集（純函式）
│     ├─ query-bridge.ts        # createRequire 載入 agent-pack/query-lib.js 的型別殼
│     ├─ prompt.ts              # 新手人格 system prompt（runtime 讀 SPEC.md）
│     ├─ checkpoint.ts          # 寫入前快照 → viewer/.agent-checkpoints/
│     ├─ session-store.ts       # M7 會話落盤 → viewer/.agent-sessions/<id>.json
│     ├─ memory-store.ts        # M7b 兩層記憶 → .agent-memory/longterm.md ＋ <id>.memory.md
│     ├─ explain.ts             # hover「深入解說」一次性 LLM 路徑
│     ├─ web-tools.ts           # web_search / web_fetch（SSRF 防護、可注入 fetch/lookup）
│     └─ agent-types.ts         # node-free wire 型別（鏡像 web/src/agent/protocol.ts）
└─ web/src/agent/
   ├─ AgentChat.tsx             # 第四分頁：對話 UI（snapshot 模式隱藏；live 模式 keep-alive 常駐）
   ├─ transcript.ts             # 純 reducer：SSE 事件 → ChatItem 列表（live 與重播共用）＋ Markdown 匯出
   ├─ sse.ts                    # 瀏覽器側 SSE client（fetch + AbortController）
   ├─ protocol.ts               # 鏡像 agent-types.ts
   └─ NodeExplainPopover.tsx    # Graph hover 解說（DB-first 純前端層）
```

遵循既有「node-free 共享型別」紀律：`agent-types.ts` 不得 import `node:` 型別。
`agent-pack/query.js` 拆為 `query-lib.js`（CJS、零依賴、`module.exports` 查詢函式、
dataDir 以參數注入）＋ `query.js`（薄 CLI 殼，介面與 28 個既有測試完全不變）。

## 3. Provider 層 — 兩個 adapter 切天下

切割依據是 **API 方言**而非品牌：

| Adapter | 覆蓋 |
|---|---|
| `anthropic`（Messages API 原生） | Claude 全系 |
| `openai-compatible`（可配 `baseUrl`） | OpenAI、DeepSeek、Qwen、Gemini 相容端點、Groq、Mistral、xAI、本地 Ollama / LM Studio（apiKey 可省略） |

放棄的只有 Gemini 原生專屬功能（多模態 inlineData 等）——可接受，走相容端點即可。

### 3.1 中性型別（provider/types.ts）

```ts
type Role = 'user' | 'assistant';
interface TextBlock       { type: 'text'; text: string }
interface ToolUseBlock    { type: 'tool_use'; id: string; name: string; input: unknown }
interface ToolResultBlock { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;
interface Message  { role: Role; content: ContentBlock[] }
interface ToolDef  { name: string; description: string; inputSchema: object }
interface ChatRequest {
  model: string; system?: string; messages: Message[];
  tools?: ToolDef[]; maxTokens?: number; signal?: AbortSignal;
}
type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }   // 僅 JSON 完整解析成功後發出
  | { type: 'usage'; inputTokens: number; outputTokens: number }     // optional：相容伺服器可能不回
  | { type: 'error'; message: string }
  | { type: 'done'; stopReason: 'end' | 'tool_use' | 'max_tokens' };
interface Provider { stream(req: ChatRequest): AsyncIterable<StreamEvent> }
```

Adapter 建構子接受可選 `fetchFn`（預設 `globalThis.fetch`）以利 fixture 測試。

**Prompt caching（2026-06-12，anthropic adapter）**：每次請求自動掛 3 個
`cache_control: {type:"ephemeral"}` 斷點——最後一個 tool def（蓋住整個工具陣列）、
system（為此 system 改傳 content-block 陣列）、最後一則訊息的最後一個 content
block（隨迭代輪輪推進的 moving breakpoint）。agent loop 的歷史在 turn 內
append-only，前一輪前綴下一輪以 ~10% 價格命中。實作鐵則：**訊息映射必須淺拷貝
每個 block**——cache_control 絕不可寫回呼叫端的中性歷史（會落盤、會送進 openai
adapter）。usage 解析同步修正：開快取後 Anthropic 的 `input_tokens` **不含**快取
部分，adapter 把 `input_tokens + cache_read + cache_creation` 加總成
StreamEvent 的 `inputTokens`（loop 的 contextTokens 閘門靠它），cache 數字另以
`cacheReadTokens`/`cacheCreationTokens` 欄位回報（0 時省略）→ loop 轉成 SSE
usage 事件的 `cachedTokens` → UI 狀態列顯示 ⚡ 快取命中。openai-compatible 後端
（OpenAI/DeepSeek/Qwen）是伺服器端自動前綴快取，無需 code、自動受益。

### 3.2 串流工具呼叫組裝（關鍵難點）

- **OpenAI 方言**：`delta.tool_calls[]` 按 `index` 為鍵累積——`id` 與 `function.name`
  只在首個 fragment 出現，`function.arguments` 為字串碎片持續串接；
  `finish_reason === 'tool_calls'` 時統一發射。需 `stream_options: {include_usage: true}`。
- **Anthropic 方言**：`content_block_start`（拿 id/name）→ `input_json_delta`
  累積 `partial_json` → `content_block_stop` 發射；usage 來自 `message_delta`。
- **統一保證**：`tool_use` 事件只在 `JSON.parse` 成功後發出。壞 JSON →
  發 `{type:'tool_use', name:'__parse_error__', input:{original_tool, raw, error}}`，
  loop 轉成 `is_error` tool_result 讓模型自修，**永不崩潰**。
- SSE 解析器邊界：跨 chunk 殘留緩衝、`\r\n|\r|\n` 全覆蓋、`:` keepalive 行跳過、
  `[DONE]` sentinel、無 trailing newline 的最後殘留。

### 3.3 組態與安全

```ts
// server-side only，存 local.config.json 的 "Llm" 欄位（檔案已 gitignored）
interface LLMConfig {
  provider: 'anthropic' | 'openai-compatible';
  baseUrl?: string;      // openai-compatible 必填；Ollama: 'http://localhost:11434/v1'
  apiKey?: string;       // Ollama 可省略
  model: string;
  maxTokens?: number;
  maxIters?: number;     // 每輪工具迴圈上限；0 = 不限制（仍受 token 上限保護）；缺省 = 8
  contextLimit?: number; // 模型上下文視窗（tokens）；驅動壓縮門檻（½）與 token 上限；缺省 = 300K/150K
}
// 前端只拿這個（GET /api/agent/status）——apiKey 永不進任何前端回應
// baseUrl 為使用者自填端點（非機密）、hasApiKey 只回布林（2026-06-11 擴充）
// maxIters / contextLimit 一併回傳供 Config 表單回填（非機密）
interface ProviderStatus {
  configured: boolean; provider?: string; model?: string;
  baseUrl?: string; hasApiKey?: boolean;
  maxIters?: number; contextLimit?: number;
}
```

`POST /api/config` 擴充收 `Llm` 物件（沿用 `cleanConfigField` 式淨化：字串、長度上限、
無控制字元）。**handleConfig 的回應維持 EnvStatus 形狀，絕不 echo Llm 欄位。**

### 3.4 降級策略

**token 統計口徑（2026-06-11 修正）**：`totalTokens` 是「累計消費」（每輪 input 重計整段
歷史，只作顯示/記帳）；`contextTokens` 是「當前上下文」（最後一輪 input+output）。
自動壓縮門檻與 contextLimit 上限一律比對 `contextTokens` — 比對累計值曾使壓縮在
上下文遠未過半時就頻繁觸發。

模型不支援工具呼叫（API 4xx 帶 tools 錯誤，或 finish 卻零 tool_use 且文字答非所問）→
回明確中文錯誤建議換模型（列例：claude-opus-4-8、gpt-4o、deepseek-chat）。
MVP **不做** JSON-in-text fallback parser——不可靠且掩蓋問題。

## 4. Tool 契約（25 個）

2026-06-11 追加七個（探索＋記憶＋壓縮）；同日再追加六個（檔案管理＋剪貼簿＋爬取提案＋公網存取）；再追加兩個（DB 修改提案＋爬取 log）；2026-06-11 bugfix 批次追加 `get_viewport`（視窗情境改為按需查詢，不再注入 prompt）；同日追加 `report_off_topic`（主題圍欄三振）：

| tool | input | returns | guard |
|---|---|---|---|
| `list_graphs` | `{}` | graphs/ 下所有 matgraph（路徑/type/name/ueVersion） | 唯讀；200 檔上限；壞檔標記不致命；不跟隨 symlink |
| `get_viewport` | `{}` | `{openGraphPath, selectedNodeId}`（無則 null） | 唯讀；資料來自前端每則訊息附帶、存於 ToolContext；**取代視窗情境注入**——開啟中的圖是環境資訊不是操作對象 |
| `search_mf` | `{query}` | 引擎＋工作 MF 索引關鍵字搜尋（SSoT 在 query-lib `searchMf`；CLI `search-mf`） | 缺索引靜默跳過 |
| `list_examples` | `{}` | agent-pack/examples 範例清單 | 唯讀 |
| `rename_graph` | `{from,to}` | 改名/搬移 matgraph（可 undo；不改寫他圖引用） | guardPath ×2；目標不得已存在 |
| `delete_graph` | `{path}` | 刪除 matgraph（pre-image 進 checkpoint，可 undo） | guardPath；刪非本對話建立的檔前先問使用者 |
| `export_to_clipboard` | `{path}` | 驗證後請前端以 T3D 複製到剪貼簿（loop 發 `export_request` 事件，前端重用導出路徑） | 圖必須 valid；複製發生在瀏覽器 |
| `request_crawl` | `{kind,contentRoot?}` | 只「提案」爬取：loop 發 `crawl_proposal`，使用者按卡片確認才走既有 POST /api/crawl | kind 限 workmf/projectmat；probeEnv 不綠直接報錯；agent 永遠拿不到拉起 UE 的權限 |
| `propose_db_edit` | `{nodeName,patch,rationale,create?}` | 只「提案」修改公開節點 DB：既有 entry 修正／verified 背書，或 `create:true` 補齊缺漏節點（強制 verified:false，待 export 爬取補 metadata）。loop 發 `db_edit_proposal`，使用者按卡片核准才走 POST /api/agent/db-edit（套用→重生索引→audit，失敗回滾） | patch 鍵 allowlist（description/category/verified/inputs/outputs/params）；create 需完整 entry 且節點不得已存在；verified:true 提案＝請使用者背書；只准乾淨 Epic/公開資料 |
| `read_crawl_log` | `{lines?}` | 最近一次「已完成」爬取的 log 尾段（kind/status/exitCode＋行） | 唯讀；上限 200 行／12K 字；由 http-server 掛 runner.lastLog() |
| `web_search` | `{query}` | 可插拔後端搜尋（2026-06-11）：Tavily／Brave／SearXNG（Config 分頁配置，`Web` 區塊）＋DuckDuckGo 零金鑰保底（html→lite 雙端點）；`auto` 依「有金鑰者優先」；配置後端失敗自動退 DDG 並附 note；回傳含 `backend` | 走 fetchPublic 同套 SSRF 防護；SearXNG base 屬使用者配置 → allowPrivate（LAN 實例合法）；金鑰存 local.config.json 永不回顯 |
| `web_fetch` | `{url, offset?}` | 抓公網頁面轉純文字（正文抽取：剝 nav/footer/aside、標題→`#` 列表→`-`）；長頁分窗：回 `totalChars`/`nextOffset`，帶 offset 續讀（每窗 15K 字） | SSRF 防護：僅 http(s)、封私網/loopback/link-local、DNS 全位址檢查、redirect 逐跳重檢（web-tools.ts）；配置 `Web.proxyUrl` 時全部流量走使用者 http 代理（CONNECT 隧道＋顯式 TLS），目標 DNS 由代理解析、本地改做主機名/IP 字面檢查 |
| `read_example` | `{name}` | 整個範例專案的 matgraph 檔 | 名稱 allowlist regex；30K 字上限 |
| `read_memory` | `{scope}` | session / longterm 記憶內容 | 路徑寫死無穿越面 |
| `update_memory` | `{scope, op: append\|replace, content}` | `{ok}` | 8K 字上限，超限響亮報錯要求 replace 精煉 |
| `compact_context` | `{}` | 壓縮輪數或「無須壓縮」說明 | **在 loop.ts 攔截執行（需 session/provider），不走 dispatchTool**；與門檻壓縮共用 `compactNow`，切點規則相同、turn 中安全 |
| `report_off_topic` | `{reason}` | 第 N 次離題的行動指示（1 提醒／2 拒答警告／3 關閉） | **在 loop.ts 攔截執行（strike 計數在 session 上，落盤持久、不因回到正題歸零）**；第 3 次 emit `session_closed` 即停（不再請求模型），HTTP 層刪整個 session（檔＋checkpoint＋session 記憶）；prompt 規則 16 要求「判斷從寬、拿不準不回報」 |

原 MVP 八個：

| tool | input | returns | guard |
|---|---|---|---|
| `search_nodes` | `{query, category?}` | 節點清單（名稱/分類/一句描述） | **verified 排前，未驗證帶 `⚠ unverified` 標記照樣返回**（不硬過濾） |
| `get_node_signature` | `{name}` | 完整 DB entry（inputs/outputs/params/pinInfo） | 查無時回近似名建議 |
| `get_mf_signature` | `{assetPath}` | MF 針腳簽名 | `/Engine/`→engine index；其他→workmf index；查無→提示跑對應爬取，**不得編造針腳名** |
| `read_graph` | `{path, summary?}` | 目前 matgraph JSON＋既存錯誤/警告（compact、不 pretty-print；`summary:true` 只回節點 id/type＋連線數，大圖先定向省一個量級） | 路徑限 `graphs/` 內、限 `.matgraph.json` |
| `write_graph` | `{path, graph, overwrite?}` | `{ok, warnings}` 或錯誤清單 | **先 validate＋MF 解析＋針腳查 DB，不過不落盤**；初建用；**拒絕覆寫非本對話建立的既有檔**（`overwrite:true` 僅限使用者明確要求整檔重寫） |
| `patch_graph` | `{path, ops[], dryRun?}` | `{ok, diff[], changedNodeIds, assignedIds?}` 或 `{applyErrors[]}` | 修改用（增量優先於 write_graph 重寫）；10 op（含意圖級 insertNode／removeNode heal）＋snake_case 別名＋自動 id＋批次報錯＋dryRun 預覽；見 §5 |
| `validate_graph` | `{path \| graph}` | 完整錯誤＋警告＋未解析 MF 針腳 | `validateGraph`+`materialStructureWarnings`+`mf-resolver` |
| `get_graph_errors` | `{path}` | 既存問題清單 | debug 用 |

共同守衛：路徑 resolve 後必須位於 `graphsRoot` 之下（防 `..` 穿越）；只准
`.matgraph.json`。寫入失敗 → 錯誤回 loop 自修，不落盤、不呈現。
落盤採 atomic write（temp → rename），watcher 自然觸發重繪。

**版本策略（修正案 7）**：不寫死 5.7。session 帶 `ueVersion`（從當前開啟的圖解析，
新建時讓用戶選、預設最新可用版）；tools 以該版本查 DB；支援集 = `agent-pack/`
裡有 `nodes-ue<v>.index.json` 的版本。

## 5. patch_graph 領域操作集

修改走 patch、初建走 write_graph。理由：LLM 輸出 diff 而非整圖（省 token、防截斷），
且 **op 列表本身就是白話 diff**，不需二次生成。

10 個 op（欄位對齊 schema 真實形狀；`why` 為可選的一句使用者看得懂的說明）：

```jsonc
{ "op": "addNode",    "id": "...", "type": "...", "params": {...}, "why": "..." }  // id 可省略→自動產生
{ "op": "insertNode", "between": {"from": "nodeId:pin", "to": "nodeId:pin"},
  "type": "...", "id": "...?", "inputPin": "...?", "outputPin": "...?" }  // 一個 op 插進既有連線（意圖級）
{ "op": "removeNode", "id": "...", "heal": true?, "healFrom": "...?" }  // 自動級聯刪邊；heal 縫合上下游
{ "op": "setParam",   "id": "...", "key": "...", "value": ..., "why": "..." }
{ "op": "removeParam", "id": "...", "key": "...", "why": "..." }        // 刪一個 param；params 清空則整欄移除
{ "op": "setNodeType", "id": "...", "type": "...", "why": "..." }       // 原地換型；連線/params 保留，驗證閘門重查針腳
{ "op": "renameNode", "id": "...", "newId": "...", "why": "..." }       // 同步 rewrite connections 引用
{ "op": "connect",    "from": "nodeId:pin", "to": "nodeId:pin", "why": "..." }
{ "op": "disconnect", "from": "nodeId:pin", "to": "nodeId:pin", "why": "..." }
{ "op": "setDescription", "value": "...", "why": "..." }
```

**可發現性（2026-06-11）**：op 清單完整寫進 tool description＋inputSchema 的 `op` enum
（先前 schema 只有 `items: {type:"object"}`，模型猜不到 op 只好整檔 write_graph 重寫——
這正是增量編輯失效的根因）；unknown op 的 applyError 會列出全部支援 op。
**別名容錯**：LLM 慣性輸出的 snake_case（`add_node`/`set_param`/`add_connection`/
`remove_connection`/`set_node_type`…）在 `normalizeOp` 統一映射到 canonical 名，
applyPatch 與 changedNodeIds 共用同一映射。

白話句型（每 op 一條，有 `why` 則附「（why）」於句尾）：
addNode→「加入了 `<type>` 節點「`<id>`」」；removeNode→「移除了節點「`<id>`」及其 N 條連線」；
setParam→「將「`<id>`」的 `<key>` 改為 `<value>`」；connect→「連接 `<from>` → `<to>`」；
disconnect→「斷開 `<from>` → `<to>`」；renameNode→「將「`<oldId>`」改名為「`<newId>`」（同步更新 N 條連線）」。

Apply flow：讀現圖 → 逐 op 套用，**收集全部失敗 op 一次回**
`{applyErrors: [{opIndex, message}…]}`（2026-06-12；先前 fail-fast 一輪只回一錯，
是「13 op 反覆退回燒 token」的放大器本體——現在一輪修完整批。失敗的 addNode 會
插入 phantom 節點防止後續 op 連鎖誤報；純函式層 ApplyResult 同時保留首錯
`opIndex/applyError` 供舊呼叫端）→ `validateGraph`＋`materialStructureWarnings`＋
MF 解析（驗證期錯誤回 `{opIndex: null, validateErrors}`，本來就是批次）→
0 error 才 atomic 落盤 → 回 `{ok, diff[], changedNodeIds, assignedIds?}`。

**自動 ID（2026-06-12）**：`addNode` 省略 `id` 時自動產生 `<type小寫去符號>_n`
（取最小不撞名的 n），以 `assignedIds: {opIndex: id}` 回報；同批後續 op 需要引用
新節點時仍應給顯式 id。changedNodeIds 改吃 applyPatch 回傳的 `resolvedOps`
（別名＋自動 id 都已解析）。

**dryRun（2026-06-12）**：`patch_graph` 帶 `dryRun:true` → 完整 apply＋驗證、
回同樣的 diff/warnings/changedNodeIds，但不落盤、不觸發 beforeWrite checkpoint；
loop 看到 `dryRun:true` 會抑制 `diff`/`graph_written` 事件（canvas 不重載），
tool 摘要顯示「預覽修改／預覽完成（未寫入）」。

邊界決策（已定，勿重議）：removeNode 級聯刪邊＋notice（非靜默）；addNode 撞 id
立即報錯含 opIndex；connect 引用不存在節點交給 validateGraph 既有檢查；
dynamic-pin 節點不做靜態 pin 驗證（與現行行為一致）；renameNode 同步改寫
所有 `connections[*].from/to` 前綴；connect 目標輸入針腳已被佔用 → 報錯並指出
現有來源（UE 輸入針腳只收一條線；改接先 disconnect，不做靜默替換）；
setNodeType 換成同型 → 報錯（提示模型 op 無效果）。

**意圖級 op（2026-06-12）**：
- `insertNode`：`between` 指定的連線必須存在 → 拆掉 → 加節點（支援自動 id）→
  兩頭接回。針腳省略時從 `pinLookup`（tools.ts 由版本 DB 注入，DB 宣告順序，
  純函式層不碰 I/O）推導**第一個** input／output 腳；reserved／dynamicPins／
  MaterialFunctionCall／未知型別 lookup 回 null → 必須顯式給 inputPin＋outputPin。
- `removeNode heal:true`：把節點唯一上游來源縫到它餵的所有下游針腳。多入腳
  已接線 → 必須 `healFrom:"<inputPin>"` 指定保留哪條（否則報錯列候選）；
  零入腳 → 報錯提示用普通 removeNode；下游跨多個**不同**輸出腳 → 報錯要求
  手動接線（單一來源頂替多種輸出語意有損）；零下游 → 退化為普通移除。

## 6. Agent Loop（loop.ts）

```
runAgent(userText, session):
  session.messages.push(user(userText))
  for i in 0..MAX_ITERS:                      # MAX_ITERS = 8
    stream = provider.stream({system, messages, tools, maxTokens})
    assistant = collect(stream, ev => emitSse(ev))   # text_delta 邊收邊串給前端
    messages.push(assistant)
    if no toolUses: break                      # 最終回覆
    for call in toolUses: results.push(dispatchTool(call, ctx))   # 寫入工具內含 validate
    messages.push(toolResults(results))
    if contextTokens > tokenCeiling: emit limit; break  # 比對當前上下文（最後一輪 in+out）；usage 缺失時以 chars/4 估算
```

- 護欄：`MAX_ITERS`、`TOKEN_CEILING`、撞上限 graceful 收尾（emit `limit` 事件，回報而非沉默）。
  「0 = 不限制」的語意收在 **loop 內**（caller 直接傳 0，不可自行換算）；不限制模式仍受
  token 天花板＋**連續失敗熔斷**約束：同檔連續 3 次寫入驗證失敗、或連續 2 次壓縮失敗 →
  emit `limit(kind:'failures')` 白話收尾（誠實 > 自信的錯）。
- 🌐 開關（2026-06-11）：`AgentChatRequest.webSearch`（缺席＝開）。**開**＝prompt 規則 11
  升級為「回覆前自判時效性、主動查證再答」；**關**＝`web_search`/`web_fetch` 從該輪
  toolDefs 移除（模型根本看不到）＋dispatch 層拒絕流浪呼叫（雙保險），prompt 換成
  「聯網已關閉」說明。前端 🌐 鈕與思考旋鈕並列、localStorage 持久。
- 主題圍欄（2026-06-11）：離題判定在模型（語意問題只能由 LLM 判），**升級執法在 server**——
  模型對無關訊息呼叫 `report_off_topic`（loop 攔截），`session.offTopicStrikes` 累加並落盤：
  第 1 次 tool_result 指示友善提醒、第 2 次指示拒答＋警告、第 3 次（`OFF_TOPIC_LIMIT`）loop
  emit `session_closed` 即停，http 層 `destroySession`（session 檔＋checkpoint＋session 記憶
  全刪，在 `res.end()` 前完成）。計數不因回到正題歸零；前端收 `session_closed` 清空綁定、
  跳過該輪列表刷新。已知限制：模型不呼叫工具就直接回答離題內容時，本機制不觸發（純 prompt 紀律）。
- 視窗情境（2026-06-11 改版）：**不再注入 prompt**——前端照舊隨訊息送 graphPath/selectedNodeId，
  server 存進 ToolContext，模型需要時呼叫 `get_viewport`。開啟中的圖是環境資訊，
  不是預設操作對象；建立 vs 修改的意圖分流寫進 system prompt 規則 13/14，
  `write_graph` 的覆寫硬守衛是最後防線。
- **使用者永遠看不到原始驗證錯誤**：錯誤只回 tool_result 餵模型自修，0 error 才呈現成果＋白話說明。
- 每輪不信記憶：修改前先 `read_graph` 對齊磁碟真實狀態（寫進 system prompt 的工具紀律）。
- Session（M7，2026-06-11 取代「單一記憶體 session」）：會話落盤
  `viewer/.agent-sessions/<id>.json`（gitignored）＝中性 messages（含 thinking block）＋
  可重播 transcript（user 文字＋SSE 事件，text/thinking 落盤時合併）＋ meta。
  `AgentChatRequest.sessionId` 顯式綁定（未知 id → 404）；無 id 走 current-session 舊流程。
  CRUD：`GET/POST /api/agent/sessions`、`GET/DELETE /api/agent/sessions/:id`。
  undo 收 `{sessionId}`；reset 只「中止＋脫離」不刪檔。undo 棧不跨重啟（已記錄的限制）。
- 記憶（M7b）：longterm（跨會話）＋ session（隨會話）兩層，僅經 read/update_memory 工具寫；
  每輪 user turn 重讀並注入 system prompt。刪會話連帶刪其 session 記憶，longterm 不動。
- 壓縮（M11-1）：`contextTokens`（當前上下文，見 §3.4）過 `COMPACT_THRESHOLD`
  （預設 150K）時，保留最後 `COMPACT_KEEP_TURNS`（4）輪、其餘以一次性無工具呼叫摘要
  進 session 記憶後裁剪歷史並重估 contextTokens。切點只能是「純文字 user 訊息」（避免孤兒 tool_result）；摘要失敗一律
  安全 no-op。發 `compacted` SSE 事件。模型也可主動呼叫 `compact_context` 工具觸發同一
  條路徑（`compactNow`，loop 內攔截）。
- 組態旋鈕（2026-06-11）：`Llm.maxIters`（0 = 不限制，HTTP 層換算成
  `Number.MAX_SAFE_INTEGER`）；`Llm.contextLimit`（tokens）同時驅動
  `compactThreshold = ½·limit` 與 `tokenCeiling = limit`。Config 分頁以兩個下拉選擇
  （8/16/32/不限制；預設/128K/200K/256K/1M）。
- Abort：前端斷線（`req.on('close')`）→ AbortController → 上游 fetch 中止。

### Checkpoint / undo（checkpoint.ts）

**寫入時記錄 pre-image**：`write_graph`/`patch_graph` 落盤前，把目標檔的原內容
（或「原本不存在」標記）存入 `viewer/.agent-checkpoints/<sessionId>/<turnN>/`。
undo = 還原最後一個 turn 的所有 pre-image（原不存在的檔則刪除），棧式彈出。
`.gitignore` 加 `viewer/.agent-checkpoints/`。

### System prompt（prompt.ts）

新手人格：白話、邊做邊解釋（「我加了控制粗糙度的節點，表面會變霧」）、zh-TW 回覆。
Runtime 從 `agent-pack/SPEC.md` 整份讀入（≈3K tokens）＋工具紀律（先 search 再
get_signature 再連線；MF 必查 `get_mf_signature`；改圖前先 `read_graph`；
禁 x/y；版本固定為 session 的 `ueVersion`）。

## 7. 傳輸與端點

串流選 SSE（不壓垮既有單一 WS）。新 SSE 長連線已被 http-server 的 socket 追蹤
（`openSockets`）覆蓋，`close()` 不會掛起；測試 teardown 記得斷流。

| 端點 | 方法 | 用途 | 守衛 |
|---|---|---|---|
| `/api/agent/chat` | POST → `text/event-stream` | 對話 loop，串 AgentSseEvent | `sameOrigin` |
| `/api/agent/explain` | POST（JSON 回應，非串流） | hover「深入解說」一次性 LLM | `sameOrigin` |
| `/api/agent/undo` | POST | 還原上一 turn 的 pre-image | `sameOrigin`；限 `graphs/` |
| `/api/agent/regenerate` | POST | 回捲最後一輪（檔案＋history＋transcript）並回傳 user 文字供前端重送 | `sameOrigin`；串流中 409；turnSeq 不回退 |
| `/api/agent/db-edit` | POST | 套用使用者核准的節點 DB 修改（驗證→寫入→重生索引→parity audit，失敗回滾） | `sameOrigin`；單飛（套用中 409） |
| `/api/agent/reset` | POST | 清空 session | `sameOrigin` |
| `/api/agent/status` | GET | `ProviderStatus`（永不含 apiKey） | 同 `/api/env` |
| `/api/agent/test` | POST | 用「已儲存」設定發最小請求驗證連線；錯誤翻白話（2026-06-11） | `sameOrigin`；30s 上限 |
| `/api/agent/web-test` | POST | 用「已儲存」`Web` 設定實搜一次（回 backend＋筆數或錯誤） | `sameOrigin` |
| `/api/agent/sessions` | GET / POST | 會話列表／新建（M7） | POST 過 `sameOrigin` |
| `/api/agent/sessions/:id` | GET / DELETE | 轉錄重播／刪除（連帶 checkpoints＋session 記憶） | id regex；DELETE 過 `sameOrigin`、串流中 409 |
| `/api/config` | POST（擴充） | 新收 `Llm` 物件；`baseUrl: ''` 表清除（兩個 provider 都收 baseUrl）。再擴充收 `Web` 物件（searchBackend／tavilyApiKey／braveApiKey／searxngBaseUrl／proxyUrl，金鑰空字串＝清除、缺席＝保留，金鑰永不回顯） | 既有守衛 |

### Wire 型別（agent-types.ts ↔ web/src/agent/protocol.ts，鏡像）

```ts
type AgentSseEvent =
  | { type: 'text'; text: string }                                   // 敘事逐字
  | { type: 'thinking'; text: string }                               // 思考串流（僅顯示；2026-06-11）
  | { type: 'tool_start'; name: string; summary: string }            // 使用者可讀的步驟行
  | { type: 'tool_end'; name: string; ok: boolean; summary?: string }
  | { type: 'diff'; lines: string[] }                                // 白話 diff（成功寫入後）
  | { type: 'graph_written'; path: string; changedNodeIds?: string[] } // UI 自動開啟＋畫布脈衝高亮變更節點
  | { type: 'export_request'; path: string }                         // UI 以 T3D 複製該圖到剪貼簿（重用導出路徑）
  | { type: 'crawl_proposal'; kind: 'workmf' | 'projectmat'; contentRoot: string } // UI 顯示確認卡，使用者核准才呼叫 POST /api/crawl
  | { type: 'db_edit_proposal'; nodeName: string; ueVersion: string; create: boolean; patch: Record<string, unknown>; rationale: string } // UI 顯示確認卡，使用者核准才呼叫 POST /api/agent/db-edit
  | { type: 'usage'; inputTokens: number; outputTokens: number; estimated: boolean }
  | { type: 'compacted'; message: string }                           // 壓縮通知（2026-06-11）
  | { type: 'limit'; kind: 'iters' | 'cost'; message: string }
  | { type: 'error'; message: string }
  | { type: 'done' };
// POST /api/agent/chat body — thinking 為每輪思考程度（2026-06-11）：
// anthropic → thinking.budget_tokens（低 2048／中 8192／高 16384，max_tokens 自動抬高）；
// openai-compatible → reasoning_effort。Anthropic 開啟思考＋工具呼叫時，
// thinking block（含 signature）必須原樣回傳歷史；關閉時須剝除——adapter 已處理。
interface AgentChatRequest {
  text: string; ueVersion?: string; graphPath?: string;
  thinking?: 'off' | 'low' | 'medium' | 'high';
  sessionId?: string;   // M7：顯式綁定持久會話；web UI 一律帶
}
```

## 8. Web UI

| 檔 / 元件 | 動作 |
|---|---|
| `Sidebar.tsx` | 第四分頁 `Agent`；**snapshot 模式隱藏**。live 模式下 AgentChat 以 display-toggled **keep-alive** 包裹常駐（待回報爬取、進行中串流、未送出輸入跨分頁存活）；分頁標籤帶注意力小點（串流中脈衝 `run`、離開分頁期間完成回覆則常亮 `new`） |
| `agent/AgentChat.tsx` | 對話 UI：敘事逐字、思考卡（live 自動捲動）、工具步驟行、diff 區塊、系統回報卡（摺疊）、爬取／DB 修改確認卡、每輪 token 用量行、輸入框（`/` 喚出快捷指令選單）、停止／還原／重新生成／新對話、會話列表切換刪除、⚡ 快捷指令（11 個：/validate /explain /export /compact /log /help /regen /undo /md /new /crawlmf）、Markdown 匯出；`status.configured === false` 引導去 Config；空狀態起手範例 |
| `agent/transcript.ts` | 純 reducer（live SSE 與會話重播共用同一實作）：ChatItem 建構、（系統回報）前綴 → 摺疊卡、per-turn 用量、`transcriptToMarkdown` |
| `agent/sse.ts` | fetch + ReadableStream 解析 SSE + AbortController |
| `Graph.tsx` | hover 停留（≈500ms）→ `NodeExplainPopover`（第一層純前端零請求；「深入解說」才呼叫 `/api/agent/explain`；平移/縮放/拖節點即關閉）；`agentHighlight` → 變更節點脈衝高亮＋fitView |
| `Inspector.tsx` | 選中節點時的「問 AI」按鈕 → `askAgent`（切到 Agent 分頁直接送出解說請求） |
| `ImportModal.tsx` | 「導入後請 AI 解說」勾選 → 匯入成功即 `askAgent` 自動開講 |
| `App.tsx` | Agent 分頁欄寬拖曳（320–800px，不持久化）；`agentAsk` → 切分頁；`agentExportReq` → 重用導出路徑完成剪貼簿複製（需 dagre 座標已渲染） |
| `ConfigPanel.tsx` | 「AI 助手」區塊：provider 選單、baseUrl、model、apiKey（password input，永不回填）、maxIters／contextLimit 下拉、測試連線、儲存後顯示 status |
| `store.tsx` | agent 相關全域狀態：`selectedNodeId`（視窗情境）、`agentAsk`（問 AI 一次性請求）、`agentHighlight`／`agentExportReq`（nonce＋時效閘）、`agentActivity`（分頁小點）、`bumpMetadata`（DB 修改後重抓 agent-pack） |

## 9. 里程碑（嚴格依序，過驗收才往下）

| | 交付 | 驗收 |
|---|---|---|
| **M0** | provider/{types,sse,anthropic,openai,index}.ts ＋ fixture 測試 | 同一 ChatRequest 經兩 adapter 對等 fixture 產生**相同 StreamEvent 序列**（text、單工具、並行工具、壞 JSON、usage、abort）；零真實 API 呼叫 |
| **M1** | query-lib.js 拆分＋query.js 薄殼；tools.ts＋patch.ts＋query-bridge.ts＋測試 | 28 個既有 query-cli 測試**原樣全綠**；每個 tool 可獨立呼叫；`write_graph` 餵不合法圖**拒絕落盤**並回錯誤清單；patch 各 op＋級聯＋rename rewrite＋白話 diff 有測試 |
| **M2** | loop.ts＋prompt.ts＋checkpoint.ts＋FakeProvider 測試 | 腳本化 FakeProvider 下：「做一個會發光的水」→ 合法 matgraph 落盤；中途餵錯能 ≤MAX_ITERS 自修；撞上限 graceful 收尾＋limit 事件；undo 還原 pre-image |
| **M3** | `/api/agent/chat`(SSE)＋`/api/agent/status`＋config 擴充＋AgentChat.tsx＋sse.ts | 分頁打白話 → 即時敘事＋節點圖更新（watcher）；apiKey 不出現在任何回應（測試斷言）；snapshot 模式無 Agent 分頁 |
| **M4** | `/api/agent/undo`＋`/api/agent/reset`＋diff 區塊 UI | 「太亮了」→ 修改＋白話變更列表；「回上一步」→ 還原前一快照 |
| **M5** | NodeExplainPopover（DB-first）＋explain.ts＋`/api/agent/explain`＋冷啟動範例 | hover → DB 解說**零 LLM 零延遲**；「深入解說」走一次性 LLM；首開能一鍵試範例 |

## 10. 測試策略（零真實 API）

- **Adapter**：錄製 SSE fixture（字串 chunk 陣列 → ReadableStream，含跨 chunk
  切割、mid-line 切割），斷言兩方言產生相同 StreamEvent 序列。
- **Loop**：`FakeProvider`（腳本化 `StreamEvent[][]`，逐輪彈出），驗證閉環自修、
  上限、checkpoint。
- **Tools**：tmp 目錄當 graphsRoot；DB 類工具直接打真 agent-pack 資料（唯讀）；
  workmf 用 tmp index 注入。
- **洩漏守衛**：斷言 `/api/agent/status`、`/api/config` 回應、SSE 流中**永不含 apiKey**。
- **評測語料**（`tests/eval/`）：宣告式情境（FakeProvider 腳本＋期望）跑真 loop/tools/
  checkpoint 棧；runner 每步強制全域不變量——單一 `done` 收尾、無非預期 error/limit、
  歷史角色嚴格交替且 tool_use 全配對、磁碟上所有 matgraph 恆過完整驗證閘門、節點永無
  x/y、使用者可見 text/diff 永不含原始英文錯誤字串、undo 永不還原 graphsRoot 之外的路徑。
  新增情境加在 `tests/eval/corpus-*.ts`。
- 跑法：`viewer/node_modules/.bin/vitest run`（node env）＋ React 元件測試走
  `vitest.react.config.ts`（happy-dom，`.test.tsx`）。

## 11. 硬性約束 — DO NOT（沿 repo CLAUDE.md，全程適用）

- ✗ 不在 matgraph 寫 x/y 座標——版面是 dagre 的工作。
- ✗ 不破壞 public-artifact purity——agent-pack 公開檔只放乾淨 Epic/公開 UE 資料。
- ✗ 不把 workmf-index 暴露給前端 bundle / HTML export（tool_result 經 LLM 是用戶
  自己的資料＋自選 provider，可接受；但對話歷史永不烤進 snapshot）。
- ✗ 不違反 SSoT——provider 切換只在 adapter 層；wire 型別兩邊鏡像；查詢邏輯只在 query-lib。
- ✗ 不讓寫入類工具跳過驗證；路徑限 `graphs/`。
- ✗ 不在改狀態端點省略 `sameOrigin`；server 維持 loopback bind。
- ✗ 不引入需額外部署的服務、不加 npm 依賴。
- ✗ `apiKey` 永不進前端回應、bundle、HTML export、git。

## 12. 功能快照（收尾，2026-06-11）

使用者視角的完整能力清單（變更任何一項記得回來改這裡）：

- **對話生圖**：白話描述 → 即時節點圖（watcher 重繪）＋白話 diff＋變更節點畫布高亮；
  錯誤一律餵回模型自修，使用者只看最終成果。
- **修改與回退**：patch 式增量修改（10 op 含意圖級 insertNode／removeNode heal、
  snake_case 別名、自動 id、批次報錯一次列全部、dryRun 預覽；op 清單寫進 tool
  schema，修改不再整檔重寫）、還原上一步（undo）、重新生成上一回覆（檔案＋歷史＋
  transcript 一併回捲）。
- **主題圍欄**：與材質／遊戲開發無關的訊息三振制——第 1 次提醒、第 2 次拒答＋警告、
  第 3 次關閉並刪除整個會話（strike 落盤，跨重啟有效）。
- **情境理解**：前端隨訊息附帶目前開啟的圖＋選取節點，模型按需以 `get_viewport` 查詢
  （不注入 prompt——開啟中的圖是環境資訊，不是預設操作對象）；「建立」意圖一律寫新檔，
  write_graph 拒絕覆寫非本對話建立的檔；Inspector「問 AI」、匯入後自動解說、hover 節點兩層解說。
- **提案—批准模型**（agent 永遠拿不到的權限）：爬取（request_crawl → 確認卡 →
  既有 POST /api/crawl）；公開節點 DB 修改／verified 背書／create 補齊
  （propose_db_edit → 確認卡 → POST /api/agent/db-edit，套用→重生索引→audit→失敗回滾）。
- **爬取閉環**：批准的爬取完成/失敗自動以（系統回報）摺疊卡回灌對話；`read_crawl_log`
  可隨時診斷最近一次爬取。
- **拿進 UE**：export_to_clipboard → 瀏覽器重用導出路徑複製 T3D，提示 Ctrl+V。
- **研究能力**：web_search 可插拔後端（Tavily／Brave／SearXNG＋DDG 保底、失敗自動退級）＋
  web_fetch（SSRF 防護、正文抽取、長頁 offset 分窗），引用附來源；可配 http 代理；
  輸入框旁 🌐 開關（默認開＝回覆前自判要不要查網路；關＝該輪完全不聯網）。
- **會話**：落盤持久＋列表切換刪除＋重播；兩層記憶；自動/手動壓縮（contextTokens 口徑）；
  每輪 token 用量＋累計消費顯示；Markdown 匯出。
- **快捷指令**：⚡ 選單或輸入 `/` 篩選執行（11 個，含 /crawlmf 直接爬取並回報）。
- **體驗**：Agent 分頁 keep-alive＋注意力小點、欄寬拖曳、思考程度旋鈕（off/low/medium/high）。
- **團隊模式（BIND_HOST 非 loopback 或 web 切換）**：預設 agent 面是 admin 專屬（gate 在
  http-server 的 `isAdminOnly`，例外只有 status/explain/public-session）。admin 可把任一
  會話「設為公告」（POST /api/agent/sessions/:id/public → `.public-session.json` 指標）；
  成員在 Agent 分頁以 `PublicAgentView` 唯讀圍觀（GET /api/agent/public-session ＋
  WS `publicAgent` 廣播：指定/清除、turn 開始串流、turn 落盤→重抓）。
  admin 開啟 `Team.memberAgent` 後成員獲得自己的私人會話（owner 隔離：成員只見自己的、
  admin 看全部含用量；成員 turn 拿不到 request_crawl/propose_db_edit）。chat 單飛降為
  **per-session**（不同會話並行串流；同一會話內 streaming/mutating/unwind 不變式照舊）。
  LLM key 一直在伺服器端（local.config.json），任何角色的瀏覽器都拿不到。

---
*v0.2 · 2026-06-10 · 分支 `feat/material-agent` · 對齊記錄見 session（verified 覆蓋
實測、洩漏路徑核實、checkpoint 位置權衡均已完成，實作時勿重新調查）*
