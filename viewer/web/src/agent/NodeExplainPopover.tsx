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
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useStore } from '../store';
import { useDb } from '../dbContext';
import type { NodeDef } from '../../../server/db-types';
import type { AgentExplainRequest, AgentExplainResponse } from './protocol';

// ---------------------------------------------------------------------------
// Reserved types — built-in descriptions (mirror server/agent/explain.ts)
// Called at render time with t so translations are applied per language.
// ---------------------------------------------------------------------------

function getReservedNodeDescriptions(t: TFunction): Record<string, string> {
  return {
    MaterialOutput: t('nodeExplain.reservedMaterialOutput'),
    FunctionInput: t('nodeExplain.reservedFunctionInput'),
    FunctionOutput: t('nodeExplain.reservedFunctionOutput'),
    MaterialFunctionCall: t('nodeExplain.reservedMaterialFunctionCall'),
  };
}

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
  const { t, i18n } = useTranslation();
  const isSnapshot = state.connection === 'snapshot';

  // Layer 1: look up DB entry (may be undefined for unknown types).
  const reservedDescriptions = getReservedNodeDescriptions(t);
  const isReserved = nodeType in reservedDescriptions;
  const dbEntry: NodeDef | undefined = db.nodes[nodeType];
  const reservedDesc = reservedDescriptions[nodeType];
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
        language: i18n.language === 'en' ? 'en' : 'zh-Hant',
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
      setExplainError((e as Error)?.message ?? t('nodeExplain.unknownError'));
    } finally {
      setExplainLoading(false);
    }
  }, [nodeType, ueVersion, graphPath, nodeId, explainLoading, cache, i18n]);

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
          title={t('nodeExplain.close')}
          aria-label={t('nodeExplain.close')}
        >
          ×
        </button>
      </div>

      {/* Layer 1 body */}
      <div className="node-explain-body" style={{ padding: '8px 10px' }}>
        {isUnknown ? (
          <div className="node-explain-unknown" style={{ color: 'var(--warn)' }}>
            ⚠ {t('nodeExplain.unknownNodeType', { nodeType })}
          </div>
        ) : (
          <>
            {/* Description */}
            <div className="node-explain-desc" style={{ color: 'var(--text)', marginBottom: 8 }}>
              {reservedDesc ?? dbEntry?.description ?? t('nodeExplain.noDescription')}
            </div>

            {/* Pins (only for DB entries, not reserved types which have no pin list) */}
            {!isReserved && (inputs.length > 0 || outputs.length > 0) && (
              <div className="node-explain-pins" style={{ marginBottom: 8 }}>
                {inputs.length > 0 && (
                  <div className="node-explain-pin-group" style={{ marginBottom: 4 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-mute)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 3 }}>
                      {t('nodeExplain.inputs')}
                    </div>
                    {inputs.map(p => (
                      <div key={p.name} className="node-explain-pin-row" style={{ display: 'flex', gap: 6, fontSize: 11, color: 'var(--text-dim)', paddingLeft: 4 }}>
                        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{p.name}</span>
                        <span style={{ color: 'var(--text-mute)' }}>{p.type}</span>
                        {p.required === false && <span style={{ color: 'var(--text-mute)', fontSize: 10 }}>{t('nodeExplain.optional')}</span>}
                      </div>
                    ))}
                  </div>
                )}
                {outputs.length > 0 && (
                  <div className="node-explain-pin-group">
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-mute)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 3 }}>
                      {t('nodeExplain.outputs')}
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
                {explainLoading ? t('nodeExplain.loading') : t('nodeExplain.deepExplain')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
