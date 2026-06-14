import { useTranslation } from 'react-i18next';
import './modal.css';
import { Icon } from './Icon';
import { estimateLinks } from './uiHelpers';

export interface BigGraphConfirmProps {
  file: { path: string; name: string; nodeCount: number };
  onCancel(): void;
  onConfirm(): void;
}

export function BigGraphConfirm({ file, onCancel, onConfirm }: BigGraphConfirmProps) {
  const { t } = useTranslation();
  const estLinks = estimateLinks(file.nodeCount);

  return (
    <div className="scrim" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <Icon name="warn" size={18} style={{ color: 'var(--warn)' }} />
          <div className="mt">{t('bigGraphConfirm.title')}</div>
        </div>
        <div className="modal-body">
          <p style={{ margin: '0 0 16px', color: 'var(--text-dim)' }}>
            <b style={{ color: 'var(--text)' }}>{file.name}</b>{' '}
            {t('bigGraphConfirm.body')}
          </p>
          <div className="stat" style={{ margin: 0 }}>
            <div className="s">
              <div className="v" style={{ color: 'var(--warn)' }}>{file.nodeCount}</div>
              <div className="l">{t('bigGraphConfirm.nodes')}</div>
            </div>
            <div className="s">
              <div className="v">~{estLinks}</div>
              <div className="l">{t('bigGraphConfirm.links')}</div>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onCancel}>{t('bigGraphConfirm.cancel')}</button>
          <button className="btn primary" onClick={onConfirm}>{t('bigGraphConfirm.confirm')}</button>
        </div>
      </div>
    </div>
  );
}
