import { useState, useMemo, useEffect } from 'react';
import type { MatGraph } from './protocol';
import { useDb } from './dbContext';
import { pinColor, catColor } from './theme/colors';
import { diagnoseGraph, isUnknownNodeType, type GraphIssue } from './graphDiagnostics';
import './inspector.css';

type Mode = 'node' | 'health';

export interface InspectorProps {
  graph?: MatGraph;
  selectedNodeId: string | null;
  derivedPins?: Record<string, { inputs: { name: string; type: string }[]; outputs: { name: string; type: string }[] }>;
  /** Schema errors for the current file when it failed to load (or is stale after a re-validation failure). */
  errors?: string[];
  /** Focus a node on the canvas when a debug issue is clicked. */
  onFocusNode?: (id: string) => void;
  /** Open graph's path — used to surface crawl freshness for crawled materials. */
  currentPath?: string;
}

function agoShort(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60); if (m < 60) return `${m} 分鐘前`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} 小時前`;
  return `${Math.floor(h / 24)} 天前`;
}
// Freshness chip for crawled project materials (graphs/_project/…), driven by the
// real projectmat crawl timestamp. Agent-authored graphs have no such stamp.
function crawledFresh(currentPath?: string): { label: string; cls: string } | null {
  if (!currentPath || !currentPath.startsWith('_project/')) return null;
  const ts = Number(localStorage.getItem('ue-crawl-fresh-projectmat') || 0);
  return ts ? { label: '上次爬取 ' + agoShort(ts), cls: 'fresh-fresh' } : { label: '爬取(唯讀)', cls: 'fresh-missing' };
}

function isCodeLike(v: unknown): v is string {
  return typeof v === 'string' && (v.includes('\n') || v.length > 40);
}

function CodeBlock({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="codeblock">
      {value}
      <button className="copy"
        onMouseDown={e => e.stopPropagation()}
        onClick={e => {
          e.stopPropagation();
          navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
        }}>
        {copied ? '✓' : '⧉'}
      </button>
    </div>
  );
}

function PinList({ title, pins }: { title: string; pins: { name: string; type: string; required?: boolean }[] }) {
  if (!pins.length) return null;
  return (
    <div className="isec">
      <div className="lbl">{title}</div>
      <div className="pinlist">
        {pins.map(p => (
          <div className="pinrow" key={p.name}>
            <span className="pc" style={{ background: pinColor(p.type) }} />
            <span className="pn">{p.name || '(out)'}</span>
            <span className="pt">{p.type}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function sevPill(s: GraphIssue['severity']): string {
  return s === 'error' ? 'ERROR' : s === 'warning' ? 'WARN' : 'INFO';
}

function IssueRows({ issues, onFocusNode }: { issues: GraphIssue[]; onFocusNode?: (id: string) => void }) {
  return (
    <>
      {issues.map((iss, i) => (
        <button key={i} type="button" className={`issue ${iss.severity}`}
          disabled={!iss.nodeId} title={iss.nodeId ? '點擊在畫布上定位' : undefined}
          onClick={() => iss.nodeId && onFocusNode?.(iss.nodeId)}>
          <span className="ibar" />
          <span className="ibody">
            <span className="it">{iss.message}</span>
            {iss.nodeId && <span className="in">{iss.nodeId}</span>}
          </span>
          <span className="sevpill">{sevPill(iss.severity)}</span>
        </button>
      ))}
    </>
  );
}

export function Inspector({ graph, selectedNodeId, derivedPins, errors, onFocusNode, currentPath }: InspectorProps) {
  const { db } = useDb();
  const [mode, setMode] = useState<Mode>('health');
  // Selecting a node jumps to node-detail; clearing it falls back to health.
  useEffect(() => { setMode(selectedNodeId ? 'node' : 'health'); }, [selectedNodeId]);

  // The graph-level health report is recomputed only when the graph / DB / resolved
  // pins actually change — not on every parent re-render (toasts, node drags, crawl ticks).
  const health = useMemo(() => {
    if (!graph) return null;
    const issues = diagnoseGraph(graph, db, derivedPins);
    const unknownCount = issues.filter(i => i.kind === 'unknown-type').length;
    const mfCount = graph.nodes.filter(n => n.type === 'MaterialFunctionCall').length;
    const errCount = issues.filter(i => i.severity === 'error').length;
    const warnCount = issues.length - errCount;
    return { issues, unknownCount, mfCount, errCount, warnCount, level: (errCount ? 'bad' : warnCount ? 'warn' : 'ok') as 'ok' | 'warn' | 'bad' };
  }, [graph, db, derivedPins]);

  const head = (
    <div className="panel-head"><span className="h">Inspector</span></div>
  );

  // A file that failed validation surfaces its errors here — even if a previously
  // loaded payload is still cached (the store keeps the last-good graph on a
  // re-validation failure), so we must check errors BEFORE the health panel.
  if (errors && errors.length > 0) {
    return (
      <div className="insp">
        {head}
        <div className="health-badge bad">
          <span className="ring">✗</span>
          <div><div className="ht">此檔無法載入</div><div className="hd">{errors.length} 個錯誤</div></div>
        </div>
        {errors.map((e, i) => (
          <div key={i} className="issue error" style={{ cursor: 'default' }}>
            <span className="ibar" />
            <span className="ibody"><span className="it">{e}</span></span>
            <span className="sevpill">ERROR</span>
          </div>
        ))}
      </div>
    );
  }
  if (!graph) return <div className="insp">{head}<div className="empty">選一個圖開始檢視。</div></div>;

  const node = selectedNodeId ? graph.nodes.find(n => n.id === selectedNodeId) : undefined;
  const { issues, unknownCount, mfCount, errCount, warnCount, level } = health!;

  const modeBar = (
    <div className="insp-mode">
      <button className={`tab ${mode === 'node' ? 'on' : ''}`} onClick={() => setMode('node')} disabled={!node}>節點詳情</button>
      <button className={`tab ${mode === 'health' ? 'on' : ''}`} onClick={() => setMode('health')}>圖健康度</button>
    </div>
  );

  // ---- Node detail ----
  if (mode === 'node' && node) {
    // Reserved types (MaterialOutput, MaterialFunctionCall, FunctionInput/Output)
    // live in db.reservedTypes, not db.nodes — they are first-class, handled types.
    const reserved = new Set(db.reservedTypes ?? []);
    const def = db.nodes[node.type];
    const unknown = isUnknownNodeType(node.type, db, reserved);
    const params = Object.entries(node.params ?? {});
    const livePins = derivedPins?.[node.id];
    const inputPins = (def?.inputs ?? livePins?.inputs ?? []);
    const outputPins = (def?.outputs ?? livePins?.outputs ?? []);
    return (
      <div className="insp">
        {head}{modeBar}
        <div className="isec">
          <div className="node-title">
            <span className="swatch" style={{ background: catColor(def?.category) }} />
            <div>
              <div className="nt">{node.type}</div>
              <div className="ntsub">{def?.category ?? 'Unknown'}</div>
            </div>
          </div>
        </div>
        {unknown && (
          <div className="insp-callout"><b>不在節點 DB 中</b><p>viewer 仍會渲染它，但導出時無法對應其 class —— 會被標記、不會被阻擋。</p></div>
        )}
        <PinList title="Inputs" pins={inputPins} />
        <PinList title="Outputs" pins={outputPins} />
        <div className="isec">
          <div className="lbl">Properties</div>
          <div className="metagrid">
            <span className="mk">ID</span><span className="mv">{node.id}</span>
            <span className="mk">Type</span><span className="mv">{node.type}</span>
            <span className="mk">Category</span><span className="mv">{def?.category ?? 'Unknown'}</span>
            {node.type === 'MaterialFunctionCall' && node.params?.MaterialFunction != null && (
              <><span className="mk">Function</span><span className="mv">{String(node.params.MaterialFunction)}</span></>
            )}
            <span className="mk">Pins</span><span className="mv">{inputPins.length} in · {outputPins.length} out</span>
          </div>
        </div>
        {params.length > 0 && (
          <div className="isec">
            <div className="lbl">Parameters</div>
            {params.map(([k, v]) => (
              <div className="iparam" key={k}>
                <div className="pk">{k}</div>
                {isCodeLike(v) ? <CodeBlock value={v} /> : <code className="inline">{JSON.stringify(v)}</code>}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ---- Graph health (default / nothing selected) ----
  const ringIco = level === 'bad' ? '✗' : level === 'warn' ? '!' : '✓';
  const ht = level === 'bad' ? '有錯誤' : level === 'warn' ? '需要注意' : '沒發現問題';
  return (
    <div className="insp">
      {head}{modeBar}
      <div className={`health-badge ${level}`}>
        <span className="ring">{ringIco}</span>
        <div>
          <div className="ht">{ht}</div>
          <div className="hd">{errCount} 個錯誤 · {warnCount} 個警告 · 已掃描 {graph.nodes.length} 個節點</div>
        </div>
      </div>
      {issues.length > 0 && <div className="issue-hint">點擊任一項可在畫布上定位該節點。</div>}
      {issues.length > 0
        ? <IssueRows issues={issues} onFocusNode={onFocusNode} />
        : <div className="empty">這張圖沒有發現結構問題。</div>}
      <div className="isec">
        <div className="lbl">Export readiness</div>
        <div className="ready-row ok">✓ {graph.nodes.length - unknownCount} / {graph.nodes.length} 個節點可對應</div>
        {mfCount > 0 && <div className="ready-row warn">ƒ {mfCount} 個 MaterialFunction 連結</div>}
      </div>
      {(() => {
        const fresh = crawledFresh(currentPath);
        return (
          <div className="isec">
            <div className="lbl-row"><span className="lbl">Metadata</span>{fresh && <span className={`fresh ${fresh.cls}`}>{fresh.label}</span>}</div>
            <div className="metagrid">
              <span className="mk">UE 版本</span><span className="mv">{graph.ueVersion}</span>
              <span className="mk">Schema</span><span className="mv">{graph.schemaVersion}</span>
              <span className="mk">類型</span><span className="mv">{graph.type}</span>
              <span className="mk">節點 / 連線</span><span className="mv">{graph.nodes.length} / {graph.connections.length}</span>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
