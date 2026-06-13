import './https-bootstrap.css';

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
  return (
    <main className="https-bootstrap-page">
      <section className="https-bootstrap-card" aria-labelledby="https-bootstrap-title">
        <h1 id="https-bootstrap-title">此連線尚未啟用安全憑證</h1>
        <p>目前使用 HTTP，因此 Chrome 會封鎖剪貼簿，無法使用「匯出到 UE」。請先安裝團隊 HTTPS 憑證。</p>
        <code className="https-bootstrap-url">{status.httpsUrl}</code>
        <div className="https-bootstrap-actions">
          <a className="https-bootstrap-primary" href={status.downloadUrl} download>
            下載並安裝 HTTPS
          </a>
          <button className="https-bootstrap-secondary" type="button" onClick={onRetry}>
            我已安裝，重新檢查
          </button>
        </div>
        <p className="https-bootstrap-note">下載後請雙擊安裝檔，並同意 Windows 系統管理員權限。安裝完成後會自動開啟安全網站。</p>
      </section>
    </main>
  );
}
