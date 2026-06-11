import { nanoid } from 'nanoid';
import { collections, logEvent, nowIso, withoutMongoIds } from './db.js';
import { broadcast } from './ws.js';

function parsePayload(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

export function emitEvent(category, event, message, payload = {}, severity = 'info') {
  const market_type = payload.market_type || payload.marketType || payload.market || null;
  const row = {
    id: nanoid(),
    category,
    severity,
    event,
    message,
    payload,
    market_type,
    exchange: payload.exchange || null,
    broker: payload.broker || null,
    symbol: payload.symbol || null,
    created_at: nowIso()
  };
  const stored = { ...row, payload: JSON.stringify(payload) };
  collections.systemEvents.insertOne(stored)
    .catch((error) => console.error(`system event write failed: ${error.message}`));
  collections.activityEvents.insertOne(stored)
    .catch(() => {});
  logEvent(severity === 'critical' ? 'error' : severity, event, payload);
  broadcast('event', row);
  return row;
}

export async function recentEvents(limit = 100, market = 'all') {
  const query = market && market !== 'all' ? { market_type: market } : {};
  const rows = await collections.systemEvents.find(query)
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray();
  return withoutMongoIds(rows)
    .map((row) => ({ ...row, payload: parsePayload(row.payload) }));
}
