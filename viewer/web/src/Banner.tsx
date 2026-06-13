import { Icon } from './Icon';

export interface BannerProps {
  conn: 'live' | 'reconnecting' | 'snapshot';
  engineMismatch: boolean;
  dismissed: boolean;
  onDismiss(): void;
}

export function Banner({ conn, engineMismatch, dismissed, onDismiss }: BannerProps) {
  const serverHost = typeof location === 'undefined' ? 'viewer server' : location.host;
  if (engineMismatch && !dismissed) {
    return (
      <div className="banner warn">
        <Icon name="warn" size={15} className="ico" />
        <span>
          此圖的引擎版本與目前 DB 不符 — 部分節點型別可能顯示為 <i>Unknown</i>，pin 顏色為近似值。
        </span>
        <button className="x" onClick={onDismiss}>
          <Icon name="x" size={14} />
        </button>
      </div>
    );
  }
  if (conn === 'snapshot') {
    return (
      <div className="banner info">
        <Icon name="layers" size={15} />
        <span>正在檢視<b>唯讀離線快照</b>。爬取與剪貼簿功能已停用。</span>
      </div>
    );
  }
  if (conn === 'reconnecting') {
    return (
      <div className="banner info">
        <Icon name="refresh" size={15} className="spin" />
        <span>正在連線 viewer server… <span style={{ color: 'var(--text-mute)' }}>{serverHost}</span></span>
      </div>
    );
  }
  return null;
}
