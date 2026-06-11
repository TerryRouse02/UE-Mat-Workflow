import { useState, useEffect, useMemo, useRef } from 'react';
import type { MatGraph, NodeSource } from './protocol';
import { useStore } from './store';
import { useDb } from './dbContext';
import { pinColor, catColor } from './theme/colors';
import { diagnoseGraph, isUnknownNodeType, type GraphIssue } from './graphDiagnostics';
import { Icon } from './Icon';
import './inspector.css';
import { fmtTimeIso as fmtTime, relTimeHours as relTime } from './timeUtils';

export interface InspectorProps {
  graph?: MatGraph;
  selectedNodeId: string | null;
  derivedPins?: Record<string, { inputs: { name: string; type: string }[]; outputs: { name: string; type: string }[] }>;
  /** Schema errors for the current file when it failed to load */
  errors?: string[];
  /** Focus a node on the canvas when a debug issue is clicked. */
  onFocusNode?: (id: string) => void;
  /** Node provenance map threaded from App. */
  nodeProvenance?: Record<string, { source: NodeSource; freshnessTs: string | null }>;
  /** Trigger a re-crawl of a node's source. */
  onRecrawlNode?: (source: string) => void;
}

type InspMode = 'node' | 'health';

// Time helpers are imported from timeUtils.ts (fmtTimeIso → fmtTime, relTimeHours → relTime).

// ─── Source label map ─────────────────────────────────────────────────────────

const SOURCE_LABEL: Record<NodeSource, string> = {
  export: '節點導出',
  workmf: '專案 MF',
  enginemf: '引擎 MF',
  projectmat: '專案母材質',
  unresolved: '—',
};

// ─── PinList ─────────────────────────────────────────────────────────────────

function PinList({ label, pins }: { label: string; pins: { name: string; type: string }[] }) {
  if (!pins.length) return null;
  return (
    <div className="panel right isec">
      <div className="lbl">{label}</div>
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

// ─── CodeBlock ───────────────────────────────────────────────────────────────

function CodeBlock({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ position: 'relative', marginTop: 4 }}>
      <div className="codeblock">{value}</div>
      <button
        className="insp-copy"
        onMouseDown={e => e.stopPropagation()}
        onClick={e => {
          e.stopPropagation();
          navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}>
        {copied ? '✓' : '⧉'}
      </button>
    </div>
  );
}

function isCodeLike(v: unknown): v is string {
  return typeof v === 'string' && (v.includes('\n') || v.length > 40);
}

// ─── NodeInspector ───────────────────────────────────────────────────────────

function NodeInspector({
  graph, node, derivedPins, nodeProvenance, onRecrawlNode, issues,
}: {
  graph: MatGraph;
  node: { id: string; type: string; params?: Record<string, unknown> };
  derivedPins?: Record<string, { inputs: { name: string; type: string }[]; outputs: { name: string; type: string }[] }>;
  nodeProvenance?: Record<string, { source: NodeSource; freshnessTs: string | null }>;
  onRecrawlNode?: (source: string) => void;
  issues: GraphIssue[];
}) {
  const { db } = useDb();
  const reserved = new Set(db.reservedTypes ?? []);
  const def = db.nodes[node.type];
  const unknown = isUnknownNodeType(node.type, db, reserved);
  const params = Object.entries(node.params ?? {});
  const catCol = catColor(def?.category);

  // Resolved pins
  const livePins = derivedPins?.[node.id];
  const inputPins = def?.inputs ?? livePins?.inputs ?? [];
  const outputPins = def?.outputs ?? livePins?.outputs ?? [];

  // Provenance metadata
  const meta = nodeProvenance?.[node.id];

  // This node's own health, filtered from the once-per-open graph scan.
  const nodeIssues = issues.filter(i => i.nodeId === node.id);

  return (
    <div className="insp">
      {/* Node title section */}
      <div className="panel right isec">
        <div className="node-title">
          <span className="swatch" style={{ background: catCol }} />
          <div>
            <div className="nt">{node.type}</div>
            <div className="ntsub">{def?.category ?? (graph.type === 'MaterialFunction' ? 'MaterialFunction' : 'Unknown')}</div>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <div className="kv">
            <span className="k">類別</span>
            <span className="v" style={{ color: catCol }}>{def?.category ?? '—'}</span>
          </div>
          <div className="kv">
            <span className="k">節點 ID</span>
            <span className="v">{node.id}</span>
          </div>
          {unknown && (
            <div className="kv">
              <span className="k">狀態</span>
              <span className="v" style={{ color: 'var(--warn)' }}>未知型別</span>
            </div>
          )}
        </div>
      </div>

      {/* This node's health — refreshed (filtered) each time a node is clicked */}
      {nodeIssues.length > 0 ? (
        <>
          <div className="panel right isec" style={{ paddingBottom: 4 }}>
            <div className="lbl">此節點的問題</div>
          </div>
          <div>
            {nodeIssues.map((iss, i) => {
              const sev = iss.severity === 'error' ? 'error' : 'warn';
              return (
                <div key={i} className={`issue ${sev}`} style={{ cursor: 'default' }}>
                  <span className="ibar" />
                  <div style={{ flex: 1 }}>
                    <div className="it">{iss.message}</div>
                  </div>
                  <span className={`sevpill ${sev}`}>{sev}</span>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="panel right isec">
          <div className="lbl" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: 'var(--ok)' }}>✓</span> 此節點無問題
          </div>
        </div>
      )}

      {/* Pin lists */}
      <PinList label="輸入 pin" pins={inputPins} />
      <PinList label="輸出 pin" pins={outputPins} />

      {/* Parameters */}
      {params.length > 0 && (
        <div className="panel right isec">
          <div className="lbl">參數 Parameters</div>
          {params.map(([k, v]) => (
            <div key={k} style={{ marginBottom: isCodeLike(v) ? 9 : 0 }}>
              <div className="kv">
                <span className="k">{k}</span>
                {!isCodeLike(v) && <span className="v">{JSON.stringify(v)}</span>}
              </div>
              {isCodeLike(v) && <CodeBlock value={v} />}
            </div>
          ))}
        </div>
      )}

      {/* Crawl metadata section */}
      {meta && (
        <div className="panel right isec">
          <div className="lbl" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="clock" size={12} /> 爬取 metadata
            {meta.source !== 'unresolved' && (
              <span className="fresh fresh-fresh" style={{ marginLeft: 'auto' }}>
                ● 新鮮
              </span>
            )}
            {meta.source === 'unresolved' && (
              <span className="fresh fresh-missing" style={{ marginLeft: 'auto' }}>
                ✕ 遺失
              </span>
            )}
          </div>
          <div className="metagrid">
            <span className="mk">來源資料集</span>
            <span className="mv">{SOURCE_LABEL[meta.source]}</span>
            <span className="mk">上次爬取</span>
            <span className="mv">{fmtTime(meta.freshnessTs)}</span>
            {meta.freshnessTs && (
              <>
                <span className="mk">&nbsp;</span>
                <span className="mv" style={{ color: 'var(--text-mute)' }}>{relTime(meta.freshnessTs)}</span>
              </>
            )}
          </div>
          {meta.source !== 'unresolved' && !meta.freshnessTs && onRecrawlNode && (
            <button
              className="btn sm"
              style={{ marginTop: 10, width: '100%', justifyContent: 'center' }}
              onClick={() => onRecrawlNode(meta.source)}>
              <Icon name="refresh" size={13} /> 重爬來源
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── HealthInspector ─────────────────────────────────────────────────────────

function HealthInspector({
  graph, issues, onFocusNode,
}: {
  graph: MatGraph;
  issues: GraphIssue[];
  onFocusNode?: (id: string) => void;
}) {
  const errCount = issues.filter(i => i.severity === 'error').length;
  const warnCount = issues.filter(i => i.severity === 'warning').length;

  // Map GraphIssue severity to health panel sev: 'warning' → 'warn'
  function toSev(sev: GraphIssue['severity']): 'error' | 'warn' {
    return sev === 'error' ? 'error' : 'warn';
  }

  // Map health level: errCount → 'error', warnCount → 'warn', else 'ok'
  const level: 'error' | 'warn' | 'ok' = errCount ? 'error' : warnCount ? 'warn' : 'ok';

  const ht = level === 'error' ? '需要注意' : level === 'warn' ? '有警告' : '一切正常';

  return (
    <div className="insp">
      <div className={`health-badge ${level}`}>
        <div className="ring"
          style={{
            background: level === 'error' ? 'rgba(224,89,78,.16)' : level === 'warn' ? 'rgba(224,166,78,.16)' : 'rgba(78,196,110,.16)',
            color: level === 'error' ? 'var(--error)' : level === 'warn' ? 'var(--warn)' : 'var(--ok)',
          }}>
          {errCount ? '!' : '✓'}
        </div>
        <div>
          <div className="ht">{ht}</div>
          <div className="hd">{errCount} 個錯誤 · {warnCount} 個警告 · 已掃描 {graph.nodes.length} 個節點</div>
        </div>
      </div>

      <div className="panel right isec" style={{ paddingBottom: 4 }}>
        <div className="lbl">問題—點擊在畫布上定位</div>
      </div>

      <div>
        {issues.map((iss, i) => {
          const sev = toSev(iss.severity);
          return (
            <div
              key={i}
              className={`issue ${sev}`}
              style={{ cursor: iss.nodeId ? 'pointer' : 'default' }}
              onClick={() => iss.nodeId && onFocusNode?.(iss.nodeId)}
              title={iss.nodeId ? '點擊聚焦該節點' : undefined}>
              <span className="ibar" />
              <div style={{ flex: 1 }}>
                <div className="it">{iss.message}</div>
                {iss.nodeId && <div className="in">{iss.nodeId}</div>}
              </div>
              <span className={`sevpill ${sev}`}>{sev}</span>
            </div>
          );
        })}
      </div>

      <div className="panel right isec">
        <div className="lbl" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 11, color: 'var(--text-mute)' }}>
          每次匯入或爬取後都會跑一次健康檢查。匯出快照前請先解決錯誤。
        </div>
      </div>
    </div>
  );
}

// ─── Main Inspector export ────────────────────────────────────────────────────

export function Inspector({
  graph,
  selectedNodeId,
  derivedPins,
  errors,
  onFocusNode,
  nodeProvenance,
  onRecrawlNode,
}: InspectorProps) {
  const { db } = useDb();
  const { state: storeState, askAgent } = useStore();
  const [inspMode, setInspMode] = useState<InspMode>('node');

  // Reset mode to 'node' when a node becomes selected (null → set transition).
  // prevSelectedRef must be a real ref so it survives across renders — a plain
  // object would be recreated every render and the null→id transition never fires.
  const prevSelectedRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedNodeId && !prevSelectedRef.current) {
      setInspMode('node');
    }
    prevSelectedRef.current = selectedNodeId;
  }, [selectedNodeId]);

  // Graph health is scanned ONCE per graph open (memoized on graph + DB + resolved
  // pins) and shared by the health tab and the per-node "this node's problems"
  // section. Clicking a node just filters this cached result — no re-scan.
  const issues = useMemo<GraphIssue[]>(
    () => (graph ? diagnoseGraph(graph, db, derivedPins) : []),
    [graph, db, derivedPins],
  );

  // Errors-first branch: file failed to load
  if (errors && errors.length > 0) {
    const errIssues: GraphIssue[] = errors.map(e => ({ severity: 'error' as const, message: e }));
    return (
      <aside className="panel right">
        <div className="panel-head">
          <span className="h">檢視器 Inspector</span>
        </div>
        <div className="insp">
          <div className="health-badge error"
            style={{ background: 'rgba(224,89,78,.1)', border: '1px solid rgba(224,89,78,.3)' }}>
            <div className="ring"
              style={{ background: 'rgba(224,89,78,.16)', color: 'var(--error)' }}>
              !
            </div>
            <div>
              <div className="ht">載入失敗</div>
              <div className="hd">此檔無法載入（{errors.length} 個錯誤）</div>
            </div>
          </div>
          <div className="panel right isec" style={{ paddingBottom: 4 }}>
            <div className="lbl">錯誤</div>
          </div>
          <div>
            {errIssues.map((iss, i) => (
              <div key={i} className="issue error" style={{ cursor: 'default' }}>
                <span className="ibar" />
                <div style={{ flex: 1 }}>
                  <div className="it">{iss.message}</div>
                </div>
                <span className="sevpill error">error</span>
              </div>
            ))}
          </div>
        </div>
      </aside>
    );
  }

  if (!graph) return <aside className="panel right" />;

  const node = selectedNodeId ? graph.nodes.find(n => n.id === selectedNodeId) : undefined;

  return (
    <aside className="panel right">
      {/* Panel header */}
      <div className="panel-head">
        <span className="h">檢視器 Inspector</span>
        <span className="grow" />
        {node && storeState.connection === 'live' && (
          <button className="iconbtn" title="請 AI 解說此節點（開啟 Agent 對話）"
            onClick={() => askAgent(`請解說目前圖中的節點「${node.id}」（型別 ${node.type}）：它的作用、參數設定，以及接線是否合理。`, true)}>
            <Icon name="chip" size={15} />
          </button>
        )}
        {node && (
          <button className="iconbtn" title="對準節點"
            onClick={() => node && onFocusNode?.(node.id)}>
            <Icon name="frame" size={15} />
          </button>
        )}
      </div>

      {/* Mode tabs */}
      <div className="insp-mode">
        <div
          className={'tab' + (inspMode === 'node' ? ' on' : '')}
          style={{ opacity: node ? 1 : 0.5 }}
          onClick={() => node && setInspMode('node')}>
          節點詳情
        </div>
        <div
          className={'tab' + (inspMode === 'health' ? ' on' : '')}
          onClick={() => setInspMode('health')}>
          圖健康度
        </div>
      </div>

      {/* Content */}
      {inspMode === 'node' && node
        ? (
          <NodeInspector
            key={node.id}
            graph={graph}
            node={node}
            derivedPins={derivedPins}
            nodeProvenance={nodeProvenance}
            onRecrawlNode={onRecrawlNode}
            issues={issues}
          />
        )
        : (
          <HealthInspector
            graph={graph}
            issues={issues}
            onFocusNode={onFocusNode}
          />
        )}
    </aside>
  );
}
