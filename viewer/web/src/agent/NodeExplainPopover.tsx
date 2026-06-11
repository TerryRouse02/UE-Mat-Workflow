// web/src/agent/NodeExplainPopover.tsx — M5 hover node explanation popover.
//
// Two layers:
//   Layer 1 (always, instant): node description + pin list from dbContext.
//     Zero fetch, zero LLM, zero cost. Always shown for known nodes.
//     Reserved types (MaterialOutput/FunctionInput/FunctionOutput/MaterialFunctionCall)
//     get a short built-in description from RESERVED_NODE_DESCRIPTIONS_WEB below.
//     Unknown types show a ⚠ 未知節點型別 message.
//   Layer 2 (on demand): 「深入解說」button → POST /api/agent/explain →
//     loading spinner → rendered text.
//     - Hidden in snapshot mode (no server).
//     - Cached per nodeType for the popover's lifetime.
//     - Disabled while loading (double-click guard).

import { useEffect, useRef, useState, useCallback } from 'react';
import { useStore } from '../store';
import { useDb } from '../dbContext';
import type { NodeDef } from '../../../server/db-types';
import type { AgentExplainRequest, AgentExplainResponse } from './protocol';

// ---------------------------------------------------------------------------
// Reserved types — built-in zh-TW descriptions (mirror server/agent/explain.ts)
// ---------------------------------------------------------------------------

const RESERVED_NODE_DESCRIPTIONS_WEB: Record<string, string> = {
  MaterialOutput:
    '材質輸出節點（MaterialOutput）是每個材質圖的終點，所有其他節點最終都要連到這裡。它接收基礎顏色（Base Color）、金屬度（Metallic）、粗糙度（Roughness）、法向量（Normal）等標準 PBR 通道，決定物體的最終視覺外觀。',
  FunctionInput:
    'MaterialFunction 輸入節點（FunctionInput）在材質函數（MaterialFunction）中定義一個外部輸入參數，讓呼叫這個函數的材質能夠傳入自訂數值，使材質函數具有可重複使用的彈性。',
  FunctionOutput:
    'MaterialFunction 輸出節點（FunctionOutput）在材質函數（MaterialFunction）中定義一個輸出，讓計算結果能夠回傳給呼叫端材質，與 FunctionInput 成對使用。',
  MaterialFunctionCall:
    '材質函數呼叫節點（MaterialFunctionCall）讓你在材質圖中插入並重複使用一段預先定義的材質邏輯（MaterialFunction）。它的輸入/輸出針腳由被呼叫的 MaterialFunction 決定，可以理解為程式設計中的「函式呼叫」。',
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface NodeExplainPopoverProps {
  nodeType: string;
  nodeId: string;
  /** Anchor x coordinate in viewport pixels (from React Flow event). */
  x: number;
  /** Anchor y coordinate in viewport pixels (from React Flow event). */
  y: number;
  /** The graph path (relative to graphs/), for graph context. */
  graphPath?: string;
  onClose: () => void;
  /**
   * Shared cache (nodeType → LLM text) owned by the parent (GraphInner).
   * Lives outside the popover so results survive close/reopen cycles.
   */
  explainCache?: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NodeExplainPopover({
  nodeType,
  nodeId,
  x,
  y,
  graphPath,
  onClose,
  explainCache,
}: NodeExplainPopoverProps) {
  const { state } = useStore();
  const { db, version: ueVersion } = useDb();
  const isSnapshot = state.connection === 'snapshot';

  // Layer 1: look up DB entry (may be undefined for unknown types).
  const isReserved = nodeType in RESERVED_NODE_DESCRIPTIONS_WEB;
  const dbEntry: NodeDef | undefined = db.nodes[nodeType];
  const reservedDesc = RESERVED_NODE_DESCRIPTIONS_WEB[nodeType];
  const isUnknown = !isReserved && !dbEntry;

  // Layer 2: deep explain state.
  // Cache: nodeType → text (so repeated hovers on same type are free).
  // Uses the parent-owned explainCache when provided so results survive close/reopen cycles;
  // falls back to a local ref for standalone usage (e.g. tests).
  const localCacheRef = useRef<Map<string, string>>(new Map());
  const cache = explainCache ?? localCacheRef.current;
  const [explainText, setExplainText] = useState<string | null>(() => cache.get(nodeType) ?? null);
  const [explainLoading, setExplainLoading] = useState(false);
  const [explainError, setExplainError] = useState<string | null>(null);

  // Close on Escape.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleDeepExplain = useCallback(async () => {
    // Double-click guard.
    if (explainLoading) return;
    // Use cache if available.
    const cached = cache.get(nodeType);
    if (cached) { setExplainText(cached); return; }

    setExplainLoading(true);
    setExplainError(null);
    try {
      const reqBody: AgentExplainRequest = {
        nodeType,
        ueVersion: ueVersion ?? undefined,
        graphPath,
        nodeId,
      };
      const res = await fetch('/api/agent/explain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reqBody),
      });
      const data = await res.json() as AgentExplainResponse;
      if (data.ok) {
        cache.set(nodeType, data.text);
        setExplainText(data.text);
      } else {
        setExplainError(data.error);
      }
    } catch (e) {
      setExplainError((e as Error)?.message ?? '發生未知錯誤');
    } finally {
      setExplainLoading(false);
    }
  }, [nodeType, ueVersion, graphPath, nodeId, explainLoading, cache]);

  // Position: keep inside viewport.
  const POPOVER_W = 300;
  const POPOVER_MAX_H = 420;
  const OFFSET_X = 12;
  const OFFSET_Y = 8;

  const clampedX = Math.min(x + OFFSET_X, (typeof window !== 'undefined' ? window.innerWidth : 1920) - POPOVER_W - 8);
  const clampedY = Math.min(y + OFFSET_Y, (typeof window !== 'undefined' ? window.innerHeight : 1080) - POPOVER_MAX_H - 8);

  // Pin display helpers.
  const inputs = dbEntry?.inputs ?? [];
  const outputs = dbEntry?.outputs ?? [];

  return (
    <div
      className="node-explain-popover"
      style={{
        position: 'fixed',
        left: clampedX,
        top: clampedY,
        width: POPOVER_W,
        maxHeight: POPOVER_MAX_H,
        zIndex: 9999,
        background: 'var(--bg-panel)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        boxShadow: '0 4px 24px rgba(0,0,0,0.45)',
        overflowY: 'auto',
        fontSize: 12,
        lineHeight: 1.55,
        color: 'var(--text)',
      }}
      // Prevent pane clicks from propagating to Graph.tsx's onPaneClick which would close Graph selection.
      onClick={e => e.stopPropagation()}
    >
      {/* Header */}
      <div
        className="node-explain-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 10px 6px',
          borderBottom: '1px solid var(--hairline)',
          gap: 8,
        }}
      >
        <span
          className="node-explain-type"
          style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 11.5, color: 'var(--text)' }}
        >
          {nodeType}
        </span>
        {dbEntry?.category && (
          <span style={{ fontSize: 10.5, color: 'var(--text-mute)', marginLeft: 'auto', marginRight: 4 }}>
            {dbEntry.category}
          </span>
        )}
        <button
          className="node-explain-close iconbtn"
          onClick={onClose}
          style={{ marginLeft: 'auto', flexShrink: 0 }}
          title="關閉"
          aria-label="關閉"
        >
          ×
        </button>
      </div>

      {/* Layer 1 body */}
      <div className="node-explain-body" style={{ padding: '8px 10px' }}>
        {isUnknown ? (
          <div className="node-explain-unknown" style={{ color: 'var(--warn)' }}>
            ⚠ 未知節點型別：{nodeType}
          </div>
        ) : (
          <>
            {/* Description */}
            <div className="node-explain-desc" style={{ color: 'var(--text)', marginBottom: 8 }}>
              {reservedDesc ?? dbEntry?.description ?? '（無描述）'}
            </div>

            {/* Pins (only for DB entries, not reserved types which have no pin list) */}
            {!isReserved && (inputs.length > 0 || outputs.length > 0) && (
              <div className="node-explain-pins" style={{ marginBottom: 8 }}>
                {inputs.length > 0 && (
                  <div className="node-explain-pin-group" style={{ marginBottom: 4 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-mute)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 3 }}>
                      輸入
                    </div>
                    {inputs.map(p => (
                      <div key={p.name} className="node-explain-pin-row" style={{ display: 'flex', gap: 6, fontSize: 11, color: 'var(--text-dim)', paddingLeft: 4 }}>
                        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{p.name}</span>
                        <span style={{ color: 'var(--text-mute)' }}>{p.type}</span>
                        {p.required === false && <span style={{ color: 'var(--text-mute)', fontSize: 10 }}>(可選)</span>}
                      </div>
                    ))}
                  </div>
                )}
                {outputs.length > 0 && (
                  <div className="node-explain-pin-group">
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-mute)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 3 }}>
                      輸出
                    </div>
                    {outputs.map(p => (
                      <div key={p.name} className="node-explain-pin-row" style={{ display: 'flex', gap: 6, fontSize: 11, color: 'var(--text-dim)', paddingLeft: 4 }}>
                        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{p.name}</span>
                        <span style={{ color: 'var(--text-mute)' }}>{p.type}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Layer 2: deep explain area */}
        {!isSnapshot && !isUnknown && (
          <div className="node-explain-deep" style={{ borderTop: '1px solid var(--hairline)', paddingTop: 8, marginTop: 4 }}>
            {explainText ? (
              <div className="node-explain-llm-text" style={{ color: 'var(--text)', whiteSpace: 'pre-wrap', fontSize: 12 }}>
                {explainText}
              </div>
            ) : explainError ? (
              <div className="node-explain-error" style={{ color: 'var(--error)', fontSize: 11 }}>
                ⚠ {explainError}
              </div>
            ) : (
              <button
                className="btn sm node-explain-deep-btn"
                disabled={explainLoading}
                onClick={() => void handleDeepExplain()}
                style={{ fontSize: 11, width: '100%', justifyContent: 'center' }}
              >
                {explainLoading ? '載入中…' : '深入解說'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
