import type { ServerMessage, ClientMessage } from './protocol';

export interface WSClient { send(msg: ClientMessage): void; close(): void; }
export interface WSHandlers {
  onMessage(m: ServerMessage): void;
  onOpen?(): void;
  onClose?(): void;
}

export function connect(handlers: WSHandlers): WSClient {
  const url = `ws://${location.host}`;
  let ws = new WebSocket(url);

  function attach() {
    ws.onopen = () => handlers.onOpen?.();
    ws.onmessage = (e) => { try { handlers.onMessage(JSON.parse(e.data)); } catch (err) { console.error('bad ws msg', err); } };
    ws.onclose = () => { handlers.onClose?.(); setTimeout(() => { ws = new WebSocket(url); attach(); }, 500); };
  }
  attach();

  return {
    send(msg) {
      const fire = () => ws.send(JSON.stringify(msg));
      if (ws.readyState === WebSocket.OPEN) fire();
      else ws.addEventListener('open', fire, { once: true });
    },
    close() { ws.close(); },
  };
}
