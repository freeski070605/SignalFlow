import { nanoid } from 'nanoid';
import { db, logEvent } from './db.js';
import { broadcast } from './ws.js';

export function emitEvent(category, event, message, payload = {}, severity = 'info') {
  const row = {
    id: nanoid(),
    category,
    severity,
    event,
    message,
    payload,
    created_at: new Date().toISOString()
  };
  db.prepare(`
    INSERT INTO system_events (id, category, severity, event, message, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(row.id, category, severity, event, message, JSON.stringify(payload));
  logEvent(severity === 'critical' ? 'error' : severity, event, payload);
  broadcast('event', row);
  return row;
}

export function recentEvents(limit = 100) {
  return db.prepare('SELECT * FROM system_events ORDER BY created_at DESC LIMIT ?').all(limit)
    .map((row) => ({ ...row, payload: row.payload ? JSON.parse(row.payload) : {} }));
}
