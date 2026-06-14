import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';

export interface BannerProps {
  conn: 'live' | 'reconnecting' | 'snapshot';
  engineMismatch: boolean;
  dismissed: boolean;
  onDismiss(): void;
}

export function Banner({ conn, engineMismatch, dismissed, onDismiss }: BannerProps) {
  const { t } = useTranslation();
  const serverHost = typeof location === 'undefined' ? 'viewer server' : location.host;
  if (engineMismatch && !dismissed) {
    return (
      <div className="banner warn">
        <Icon name="warn" size={15} className="ico" />
        <span>
          {t('banner.engineMismatch')} <i>Unknown</i>{t('banner.engineMismatchSuffix')}
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
        <span>{t('banner.snapshotPrefix')}<b>{t('banner.snapshotLabel')}</b>{t('banner.snapshotSuffix')}</span>
      </div>
    );
  }
  if (conn === 'reconnecting') {
    return (
      <div className="banner info">
        <Icon name="refresh" size={15} className="spin" />
        <span>{t('banner.reconnecting')} <span style={{ color: 'var(--text-mute)' }}>{serverHost}</span></span>
      </div>
    );
  }
  return null;
}
