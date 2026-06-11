// tests/eval/corpus-actions.ts — viewer-action + research tool scenarios:
// clipboard export, crawl proposal (propose → user report → resume), file
// rename with undo, web research with citation, DB-edit proposal, and crawl
// log diagnosis. All network/env/crawl-log access is injected via ctxExtras —
// zero real requests, zero UE installs.

import { expect } from 'vitest';
import type { Scenario } from './scenario.js';
import { chat, toolTurn, textTurn, undo } from './scenario.js';
import { basicPbrGraph } from './fixtures.js';

const READY_ENV = {
  ready: true, platform: 'win32', projectPath: 'C:/proj', engineRoot: 'C:/ue', checks: {},
} as never;

const DDG_SAMPLE = `
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdev.epicgames.com%2Fdocumentation%2Fen-us%2Funreal-engine%2Fsubstrate-materials&rut=x">Substrate Materials in UE</a>
  <a class="result__snippet" href="#">Substrate replaces the legacy shading models.</a>
</div>`;

const ARTICLE = '<html><body><h1>Substrate Materials</h1><p>Substrate replaces fixed shading models with modular slabs.</p></body></html>';

const webFakes = {
  fetchFn: (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes('duckduckgo.com')) {
      return new Response(DDG_SAMPLE, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    return new Response(ARTICLE, { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch,
  lookupFn: async () => [{ address: '93.184.216.34' }],
};

export const actionScenarios: Scenario[] = [
  {
    name: 'actions: finished material → export_to_clipboard signals the viewer and reminds Ctrl+V',
    description: 'export_to_clipboard validates the graph, emits export_request for the browser-side copy, and the narration tells the user to paste in UE.',
    seedFiles: { 'demo/metal.matgraph.json': basicPbrGraph('metal') },
    steps: [
      chat(
        '把 demo/metal 複製到剪貼簿，我要貼進 UE',
        [
          toolTurn({ id: 'a1-exp', name: 'export_to_clipboard', input: { path: 'demo/metal.matgraph.json' } }),
          textTurn('已把材質複製到剪貼簿，請到 UE 材質編輯器按 Ctrl+V 貼上。'),
        ],
        {
          toolCalls: ['export_to_clipboard'],
          toolEndOk: [true],
          eventTypesInclude: ['export_request'],
          textIncludes: ['Ctrl+V'],
        },
      ),
    ],
  },

  {
    name: 'actions: missing project MF → crawl proposal, then the system report resumes the work',
    description: 'request_crawl only proposes (crawl_proposal event + end turn); the crawl-result report message re-enters the loop and the agent re-queries.',
    ctxExtras: { probeEnvFn: async () => READY_ENV },
    steps: [
      chat(
        '我專案裡有個 MF_RimGlow，你接進來用',
        [
          toolTurn({ id: 'a2-mf', name: 'search_mf', input: { query: 'MF_RimGlow' } }),
          toolTurn({ id: 'a2-crawl', name: 'request_crawl', input: { kind: 'workmf' } }),
          textTurn('索引裡還沒有這個 MF。我已送出爬取確認卡——請按「開始爬取」，完成後我會收到回報再繼續。'),
        ],
        {
          toolCalls: ['search_mf', 'request_crawl'],
          eventTypesInclude: ['crawl_proposal'],
          textIncludes: ['開始爬取'],
        },
      ),
      chat(
        '（系統回報）workmf 爬取已完成\n（給 AI）這是你先前請求的爬取。請繼續先前的工作，需要的話重新查詢索引。\n\nlog 尾段：\nWrote work-MF index: agent-pack/workmf-index.json (12 function(s), 0 load failure(s))',
        [
          toolTurn({ id: 'a2-mf2', name: 'search_mf', input: { query: 'MF_RimGlow' } }),
          textTurn('索引更新了，我重新查過 MF_RimGlow，接下來把它接進材質。'),
        ],
        {
          toolCalls: ['search_mf'],
          textIncludes: ['重新查'],
        },
      ),
    ],
  },

  {
    name: 'actions: rename_graph moves the file and undo restores BOTH paths',
    description: 'rename snapshots source content and target absence, so one undo puts the old name back and removes the new one.',
    seedFiles: { 'fm/old_name.matgraph.json': basicPbrGraph('old_name') },
    steps: [
      chat(
        '把 fm/old_name 改名成 fm/metal_base',
        [
          toolTurn({
            id: 'a3-rn', name: 'rename_graph',
            input: { from: 'fm/old_name.matgraph.json', to: 'fm/metal_base.matgraph.json' },
          }),
          textTurn('改好名了：fm/metal_base。注意其他圖若引用舊路徑需要一併修正。'),
        ],
        {
          toolCalls: ['rename_graph'],
          toolEndOk: [true],
          graphWritten: ['fm/metal_base.matgraph.json'],
          diffIncludes: ['改名'],
          files: [
            { path: 'fm/old_name.matgraph.json', exists: false },
            { path: 'fm/metal_base.matgraph.json', exists: true, check: (g) => expect(g.name).toBe('old_name') },
          ],
        },
      ),
      undo({
        restored: 2,
        files: [
          { path: 'fm/old_name.matgraph.json', exists: true },
          { path: 'fm/metal_base.matgraph.json', exists: false },
        ],
      }),
    ],
  },

  {
    name: 'actions: stale knowledge → web_search then web_fetch, answer cites the source URL',
    description: 'web research flow with injected network: search hits DuckDuckGo parsing, fetch strips the article, and the narration carries the source link.',
    ctxExtras: { web: webFakes },
    steps: [
      chat(
        'UE 的 Substrate 材質是什麼？你的知識可能舊了，去查官方資料',
        [
          toolTurn({ id: 'a4-ws', name: 'web_search', input: { query: 'UE Substrate materials official documentation' } }),
          toolTurn({ id: 'a4-wf', name: 'web_fetch', input: { url: 'https://dev.epicgames.com/documentation/en-us/unreal-engine/substrate-materials' } }),
          textTurn('查到了：Substrate 用模組化的 slab 取代固定 shading model。（來源：https://dev.epicgames.com/documentation/en-us/unreal-engine/substrate-materials）'),
        ],
        {
          toolCalls: ['web_search', 'web_fetch'],
          toolEndOk: [true, true],
          textIncludes: ['dev.epicgames.com'],
        },
      ),
    ],
  },

  {
    name: 'actions: DB entry wrong → propose_db_edit emits a proposal card and ends the turn',
    description: 'The agent proposes a public-DB correction with rationale; only the user-approved endpoint may write it.',
    steps: [
      chat(
        'Multiply 這個節點明明驗證過了，DB 裡 verified 卻沒標',
        [
          toolTurn({
            id: 'a5-db', name: 'propose_db_edit',
            input: { nodeName: 'Multiply', patch: { verified: true }, rationale: '已對照 UE 5.7 編輯器逐項核對 pin 與參數' },
          }),
          textTurn('我已送出節點 DB 修改提案（Multiply：verified → true），請你在卡片上確認後伺服器才會套用。'),
        ],
        {
          toolCalls: ['propose_db_edit'],
          toolEndOk: [true],
          eventTypesInclude: ['db_edit_proposal'],
          textIncludes: ['提案'],
        },
      ),
    ],
  },

  {
    name: 'actions: crawl failed → read_crawl_log diagnoses from the captured tail',
    description: 'read_crawl_log surfaces the last finished crawl tail so the agent explains the failure in plain language.',
    ctxExtras: {
      getCrawlLog: () => ({
        kind: 'workmf',
        status: 'error',
        exitCode: 1,
        lines: ['LogInit: Display: Loading plugin NodeT3DMetadata', 'Error: plugin DLL incompatible with engine build', 'exit 1'],
      }),
    },
    steps: [
      chat(
        '剛剛的爬取失敗了，幫我看看怎麼回事',
        [
          toolTurn({ id: 'a6-log', name: 'read_crawl_log', input: {} }),
          textTurn('看了 log：外掛 DLL 跟你的引擎版本不相容。請用 -ForcePackage 重新打包外掛後再爬一次。'),
        ],
        {
          toolCalls: ['read_crawl_log'],
          toolEndOk: [true],
          textIncludes: ['重新打包'],
        },
      ),
    ],
  },
];
