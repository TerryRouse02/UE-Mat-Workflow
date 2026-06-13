import './theme.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { HttpsBootstrap, loadHttpsBootstrap, shouldShowHttpsBootstrap } from './HttpsBootstrap';

const root = createRoot(document.getElementById('root')!);

async function renderApp() {
  try {
    const status = await loadHttpsBootstrap();
    if (shouldShowHttpsBootstrap(status, window.isSecureContext)) {
      root.render(<HttpsBootstrap status={status} onRetry={() => { window.location.href = status.httpsUrl!; }} />);
      return;
    }
  } catch {
    // HTTPS bootstrap is optional; preserve the existing Viewer startup path.
  }
  root.render(<App />);
}

void renderApp();
