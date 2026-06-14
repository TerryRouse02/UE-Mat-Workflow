import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './cmdk.css';
import { Icon } from './Icon';
import { mapCatColor } from './nodeLibraryConstants';
import type { NodeJson } from './protocol';
import type { NodeDB } from '../../server/db-types';
import { matchesCmd, matchesNode } from './uiHelpers';

export interface CommandPaletteProps {
  onClose(): void;
  onJump(id: string): void;
  onCmd(id: string): void;
  nodes: NodeJson[];
  db: NodeDB;
  connection: string;
  envReady: boolean;
}

interface CmdItem {
  t: 'a';
  id: string;
  label: string;
  icon: string;
  disabled?: boolean;
}

interface NodeItem {
  t: 'n';
  node: { id: string; title: string; cat: string | undefined };
}

type FlatItem = CmdItem | NodeItem;

export function CommandPalette({ onClose, onJump, onCmd, nodes, db, connection, envReady }: CommandPaletteProps) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keep the keyboard-selected row visible when arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector('.cmdk-item.on')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  // Build node items: jump target is n.id; use current category palette for the dot
  const nodeItems: NodeItem[] = (nodes ?? []).map(n => ({
    t: 'n' as const,
    node: {
      id: n.id,
      title: n.type,
      cat: db?.nodes[n.type]?.category,
    },
  }));

  // Commands with greying rules
  const cmds: CmdItem[] = [
    { t: 'a', id: 'config',    label: t('commandPalette.cmdConfig'),    icon: 'settings' },
    {
      t: 'a', id: 'crawlMat', label: t('commandPalette.cmdCrawlMat'),  icon: 'refresh',
      disabled: !(connection === 'live' && envReady),
    },
    {
      t: 'a', id: 't3dIn',    label: t('commandPalette.cmdT3dIn'),     icon: 'upload',
      disabled: connection === 'snapshot',
    },
    { t: 'a', id: 't3dOut',   label: t('commandPalette.cmdT3dOut'),    icon: 'download' },
  ];

  const filteredCmds = cmds.filter(c => matchesCmd(c, q));
  const filteredNodes = nodeItems.filter(n => matchesNode({ title: n.node.title, id: n.node.id }, q));

  const flat: FlatItem[] = [
    ...filteredCmds,
    ...filteredNodes,
  ];

  const choose = (item: FlatItem | undefined) => {
    if (!item) return;
    if (item.t === 'a') {
      if (!item.disabled) {
        onCmd(item.id);
        onClose();
      }
    } else {
      onJump(item.node.id);
      onClose();
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel(s => Math.min(flat.length - 1, s + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel(s => Math.max(0, s - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(flat[sel]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  // Node header separator index
  const cmdCount = filteredCmds.length;

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="modal cmdk" onMouseDown={e => e.stopPropagation()}>
        <div className="cmdk-input">
          <Icon name="search" size={18} style={{ color: 'var(--text-mute)' }} />
          <input
            ref={inputRef}
            value={q}
            onChange={e => { setQ(e.target.value); setSel(0); }}
            onKeyDown={onKey}
            placeholder={t('commandPalette.inputPlaceholder')}
          />
          <kbd style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-mute)' }}>ESC</kbd>
        </div>
        <div className="cmdk-list" ref={listRef}>
          {filteredCmds.length > 0 && (
            <div className="cmdk-group">{t('commandPalette.groupCmds')}</div>
          )}
          {flat.map((item, i) => {
            if (item.t === 'a') {
              return (
                <div
                  key={item.id}
                  className={'cmdk-item' + (sel === i ? ' on' : '') + (item.disabled ? ' disabled' : '')}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => choose(item)}
                  aria-disabled={item.disabled}
                >
                  <span className="ci">
                    <Icon name={item.icon as Parameters<typeof Icon>[0]['name']} size={15} />
                  </span>
                  <span className="cl">{item.label}</span>
                  <span className="ck">⏎</span>
                </div>
              );
            } else {
              const isNodeHeaderBoundary = i === cmdCount;
              const catColor = mapCatColor(item.node.cat);
              const row = (
                <div
                  key={item.node.id}
                  className={'cmdk-item' + (sel === i ? ' on' : '')}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => choose(item)}
                >
                  <span className="ci">
                    <span style={{ width: 9, height: 9, borderRadius: 2, background: catColor, display: 'inline-block' }} />
                  </span>
                  <span className="cl">{item.node.title}</span>
                  <span className="cnodes">{item.node.cat ?? '—'}</span>
                </div>
              );
              if (isNodeHeaderBoundary) {
                return [
                  <div key="__node-group__" className="cmdk-group">{t('commandPalette.groupNodes', { count: filteredNodes.length })}</div>,
                  row,
                ];
              }
              return row;
            }
          })}
          {flat.length === 0 && (
            <div className="empty" style={{ padding: '18px 12px', color: 'var(--text-mute)', fontSize: 12, textAlign: 'center' }}>
              {t('commandPalette.noResults', { q })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
