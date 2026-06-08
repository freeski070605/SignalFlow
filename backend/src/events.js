import { nanoid } from 'nanoid';
import { collections, logEvent, nowIso, withoutMongoIds } from './db.js';
import { broadcast } from './ws.js';

export function emitEvent(category, event, message, payload = {}, severity = 'info') {
  const row = {
    id: nanoid(),
    category,
    severity,
    event,
    message,
    payload,
    created_at: nowIso()
  };
  collections.systemEvents.insertOne({ ...row, payload: JSON.stringify(payload) })
    .catch((error) => console.error(`system event write failed: ${error.message}`));
  logEvent(severity === 'critical' ? 'error' : severity, event, payload);
  broadcast('event', row);
  return row;
}

export async function recentEvents(limit = 100) {
  const rows = await collections.systemEvents.find({})
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray();
  return withoutMongoIds(rows)
    .map((row) => ({ ...row, payload: row.payload ? JSON.parse(row.payload) : {} }));
}
