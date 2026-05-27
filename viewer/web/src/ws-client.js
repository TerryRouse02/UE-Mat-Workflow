export function connect(onMessage) {
    const url = `ws://${location.host}`;
    let ws = new WebSocket(url);
    function attach() {
        ws.onmessage = (e) => { try {
            onMessage(JSON.parse(e.data));
        }
        catch (err) {
            console.error('bad ws msg', err);
        } };
        ws.onclose = () => { setTimeout(() => { ws = new WebSocket(url); attach(); }, 500); };
    }
    attach();
    return {
        send(msg) {
            const fire = () => ws.send(JSON.stringify(msg));
            if (ws.readyState === WebSocket.OPEN)
                fire();
            else
                ws.addEventListener('open', fire, { once: true });
        },
        close() { ws.close(); },
    };
}
