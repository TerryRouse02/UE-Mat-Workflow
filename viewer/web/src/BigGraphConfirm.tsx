import './modal.css';
import { Icon } from './Icon';

export interface BigGraphConfirmProps {
  file: { path: string; name: string; nodeCount: number };
  onCancel(): void;
  onConfirm(): void;
}

export function BigGraphConfirm({ file, onCancel, onConfirm }: BigGraphConfirmProps) {
  const estLinks = Math.round(file.nodeCount * 1.6);

  return (
    <div className="scrim" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <Icon name="warn" size={18} style={{ color: 'var(--warn)' }} />
          <div className="mt">開啟大型圖？</div>
        </div>
        <div className="modal-body">
          <p style={{ margin: '0 0 16px', color: 'var(--text-dim)' }}>
            <b style={{ color: 'var(--text)' }}>{file.name}</b>{' '}
            是一張大型材質圖。一次渲染所有節點可能會讓瀏覽器短暫卡頓。
          </p>
          <div className="stat" style={{ margin: 0 }}>
            <div className="s">
              <div className="v" style={{ color: 'var(--warn)' }}>{file.nodeCount}</div>
              <div className="l">節點</div>
            </div>
            <div className="s">
              <div className="v">~{estLinks}</div>
              <div className="l">連線（估計）</div>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onCancel}>取消</button>
          <button className="btn primary" onClick={onConfirm}>仍要開啟</button>
        </div>
      </div>
    </div>
  );
}
