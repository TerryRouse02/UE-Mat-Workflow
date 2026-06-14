import './https-bootstrap.css';
import { useTranslation } from 'react-i18next';

export interface HttpsBootstrapStatus {
  configured: boolean;
  httpsUrl?: string;
  installerVersion?: string;
  downloadAvailable: boolean;
  downloadUrl?: string;
}

export async function loadHttpsBootstrap(fetchImpl: typeof fetch = fetch): Promise<HttpsBootstrapStatus> {
  const response = await fetchImpl('/api/https-bootstrap', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`HTTPS bootstrap request failed: ${response.status}`);
  return await response.json() as HttpsBootstrapStatus;
}

export function shouldShowHttpsBootstrap(status: HttpsBootstrapStatus, secureContext: boolean): boolean {
  return status.configured === true && status.downloadAvailable === true && !!status.httpsUrl && !secureContext;
}

export function HttpsBootstrap({ status, onRetry }: { status: HttpsBootstrapStatus; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <main className="https-bootstrap-page">
      <section className="https-bootstrap-card" aria-labelledby="https-bootstrap-title">
        <h1 id="https-bootstrap-title">{t('httpsBootstrap.title')}</h1>
        <p>{t('httpsBootstrap.description')}</p>
        <code className="https-bootstrap-url">{status.httpsUrl}</code>
        <div className="https-bootstrap-actions">
          <a className="https-bootstrap-primary" href={status.downloadUrl} download>
            {t('httpsBootstrap.downloadButton')}
          </a>
          <button className="https-bootstrap-secondary" type="button" onClick={onRetry}>
            {t('httpsBootstrap.retryButton')}
          </button>
        </div>
        <p className="https-bootstrap-note">{t('httpsBootstrap.installNote')}</p>
      </section>
    </main>
  );
}
