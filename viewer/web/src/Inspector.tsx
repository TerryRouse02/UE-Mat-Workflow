import { useState } from 'react';
import type { MatGraph } from './protocol';
import { useDb } from './dbContext';
import { pinColor, catColor } from './theme/colors';
import { diagnoseGraph } from './graphDiagnostics';
import './inspector.css';

export interface InspectorProps {
  graph?: MatGraph;
  selectedNodeId: string | null;
  derivedPins?: Record<string, { inputs: { name: string; type: string }[]; outputs: { name: string; type: string }[] }>;
  /** Schema errors for the current file when it failed to load (no graph). */
  errors?: string[];
  /** Focus a node on the canvas when a debug issue is clicked. */
  onFocusNode?: (id: string) => void;
}

function isCodeLike(v: unknown): v is string {
  return typeof v === 'string' && (v.includes('\n') || v.length > 40);
}

function CodeBlock({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="insp-code">
      <pre>{value}</pre>
      <button className="insp-copy"
        onMouseDown={e => e.stopPropagation()}
        onClick={e => {
          e.stopPropagation();
          navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
        }}>
        {copied ? '✓ Copied' : '⧉ Copy'}
      </button>
    </div>
  );
}

function PinList({ title, pins }: { title: string; pins: { name: string; type: string; required?: boolean }[] }) {
  if (!pins.length) return null;
  return (
    <div className="insp-section">
      <div className="insp-sub">{title}</div>
      {pins.map(p => (
        <div className="insp-pin" key={p.name}>
          <span className="insp-pindot" style={{ background: pinColor(p.type) }} />
          <span>{p.name || '(out)'}</span>
          <span className="insp-pintype mono">{p.type}</span>
        </div>
      ))}
    </div>
  );
}

export function Inspector({ graph, selectedNodeId, derivedPins, errors, onFocusNode }: InspectorProps) {
  const { db } = useDb();
  // Reserved types (MaterialOutput, MaterialFunctionCall, FunctionInput/Output)
  // live in db.reservedTypes, not db.nodes — they are first-class, handled types,
  // NOT unknown expressions.
  const reserved = new Set(db.reservedTypes ?? []);
  if (!graph) {
    // No graph means it failed schema validation; show why it won't load.
    if (errors && errors.length > 0) {
      return (
        <aside className="inspector-wrap insp">
          <div className="insp-eyebrow"><span className="mono">載入失敗</span></div>
          <div className="insp-health bad">✗ 此檔無法載入（{errors.length}）</div>
          <div className="insp-section">
            <div className="insp-sub">錯誤</div>
            {errors.map((e, i) => (
              <div key={i} className="insp-issue error static"><span className="insp-issue-ico">✗</span><span className="insp-issue-msg">{e}</span></div>
            ))}
          </div>
        </aside>
      );
    }
    return <aside className="inspector-wrap" />;
  }

  const node = selectedNodeId ? graph.nodes.find(n => n.id === selectedNodeId) : undefined;

  if (node) {
    const def = db.nodes[node.type];
    const unknown = !def && !reserved.has(node.type);
    const params = Object.entries(node.params ?? {});
    return (
      <aside className="inspector-wrap insp">
        <div className="insp-eyebrow">
          <span className="insp-catdot" style={{ background: catColor(def?.category) }} />
          <span className="mono">{def?.category ?? 'Unknown'}</span>
        </div>
        <div className="insp-title">{node.type}</div>
        {unknown && (
          <div className="insp-callout">
            <b>Not in node DB</b>
            <p>The viewer renders it, but Export can't map its class — it'll be flagged, not blocked.</p>
          </div>
        )}
        {(() => {
          const livePins = derivedPins?.[node.id];
          const inputPins = (def?.inputs ?? livePins?.inputs ?? []);
          const outputPins = (def?.outputs ?? livePins?.outputs ?? []);
          return <>
            <PinList title="Inputs" pins={inputPins} />
            <PinList title="Outputs" pins={outputPins} />
          </>;
        })()}
        {params.length > 0 && (
          <div className="insp-section">
            <div className="insp-sub">Parameters</div>
            {params.map(([k, v]) => (
              <div className="insp-param" key={k}>
                <div className="insp-plabel">{k}</div>
                {isCodeLike(v) ? <CodeBlock value={v} /> : <code className="mono">{JSON.stringify(v)}</code>}
              </div>
            ))}
          </div>
        )}
      </aside>
    );
  }

  // Unselected: a graph-level debug / health report for the open file.
  const unknownCount = graph.nodes.filter(n => !db.nodes[n.type] && !reserved.has(n.type)).length;
  const mfCount = graph.nodes.filter(n => n.type === 'MaterialFunctionCall').length;
  const issues = diagnoseGraph(graph, db, derivedPins);
  const errCount = issues.filter(i => i.severity === 'error').length;
  const warnCount = issues.length - errCount;
  const health = errCount ? 'bad' : warnCount ? 'warn' : 'ok';
  return (
    <aside className="inspector-wrap insp">
      <div className="insp-eyebrow"><span className="mono">{graph.type === 'MaterialFunction' ? 'MaterialFunction' : 'Material'}</span></div>
      <div className="insp-title">{graph.name}</div>
      <div className="insp-subtitle">{graph.nodes.length} nodes · {graph.connections.length} links</div>

      <div className={`insp-health ${health}`}>
        {errCount ? `✗ ${errCount} 個問題${warnCount ? ` · ${warnCount} 警告` : ''}`
          : warnCount ? `⚠ ${warnCount} 個警告`
          : '✓ 沒發現問題'}
      </div>

      {issues.length > 0 && (
        <div className="insp-section">
          <div className="insp-sub">問題 / 缺什麼</div>
          {issues.map((iss, i) => (
            <button key={i} type="button"
              className={`insp-issue ${iss.severity}${iss.nodeId ? '' : ' static'}`}
              disabled={!iss.nodeId}
              title={iss.nodeId ? '點擊聚焦該節點' : undefined}
              onClick={() => iss.nodeId && onFocusNode?.(iss.nodeId)}>
              <span className="insp-issue-ico">{iss.severity === 'error' ? '✗' : '⚠'}</span>
              <span className="insp-issue-msg">{iss.message}</span>
              {iss.nodeId && <span className="insp-issue-go">→</span>}
            </button>
          ))}
        </div>
      )}

      <div className="insp-section">
        <div className="insp-sub">Export readiness</div>
        <div className="ready-row ok">✓ {graph.nodes.length - unknownCount} of {graph.nodes.length} nodes mapped</div>
        {mfCount > 0 && <div className="ready-row">ƒ {mfCount} MaterialFunction link{mfCount > 1 ? 's' : ''}</div>}
      </div>
    </aside>
  );
}
