import { WebSocketServer } from 'ws';

let wss;

export function attachWebSocket(server) {
  wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'connected', at: new Date().toISOString() }));
  });
}

export function broadcast(type, payload) {
  if (!wss) return;
  const body = JSON.stringify({ type, payload, at: new Date().toISOString() });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(body);
  });
}
