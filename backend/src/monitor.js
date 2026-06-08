import { nanoid } from 'nanoid';
import { config } from './config.js';
import { db, getSetting } from './db.js';
import { getLatestPrice, submitMarketExitOrder } from './alpaca.js';
import { coinbaseCryptoAdapter } from './adapters/coinbaseCryptoAdapter.js';
import { emitEvent } from './events.js';
import { broadcast } from './ws.js';

let timer = null;
let running = false;
let lastRunAt = null;
let lastError = null;

const activeStatuses = ['pending_entry', 'open', 'stale'];

export function createMonitoredPosition({ symbol, order, signal, notional, qty, marketType = signal?.market_type || 'stocks', exchange = signal?.exchange || 'alpaca', adapterName = signal?.adapter_name || exchange }) {
  const id = nanoid();
  const [baseAsset, quoteAsset = 'USD'] = symbol.includes('-') ? symbol.split('-') : [symbol, 'USD'];
  db.prepare(`
    INSERT INTO monitored_positions
    (id, market_type, exchange, adapter_name, symbol, base_asset, quote_asset, product_id, side, alpaca_order_id, entry_order_id, qty, notional, entry_price, stop_loss, take_profit, current_price, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'long', ?, ?, ?, ?, ?, ?, ?, ?, 'pending_entry')
  `).run(
    id,
    marketType,
    exchange,
    adapterName,
    symbol,
    baseAsset,
    quoteAsset,
    symbol,
    order.id,
    order.id,
    Number(qty),
    Number(notional),
    Number(signal.entry_price),
    Number(signal.stop_loss),
    Number(signal.take_profit),
    Number(signal.entry_price)
  );
  emitEvent('Monitor', 'protection_assigned', `${symbol} assigned SignalFlow monitored exits.`, { id, symbol, stop_loss: signal.stop_loss, take_profit: signal.take_profit });
  return id;
}

export function monitoredPositions() {
  return db.prepare('SELECT * FROM monitored_positions ORDER BY opened_at DESC').all();
}

export function monitoredPosition(id) {
  return db.prepare('SELECT * FROM monitored_positions WHERE id = ?').get(id);
}

export function activeMonitoredPositionForSymbol(symbol) {
  return db.prepare(`
    SELECT * FROM monitored_positions
    WHERE symbol = ? AND status IN ('pending_entry', 'open', 'stale', 'manual_attention_required')
    ORDER BY opened_at DESC
    LIMIT 1
  `).get(symbol);
}

export function markManualCloseInProgress(symbol) {
  const row = activeMonitoredPositionForSymbol(symbol);
  if (!row) return null;
  db.prepare(`
    UPDATE monitored_positions
    SET status = 'exiting', exit_reason = 'manual_close', error_message = NULL
    WHERE id = ?
  `).run(row.id);
  emitEvent('Monitor', 'monitored_manual_close_started', `${symbol} monitored position marked exiting for manual close.`, { id: row.id, symbol }, 'warn');
  broadcast('monitor_update', { id: row.id, symbol, status: 'exiting' });
  return monitoredPosition(row.id);
}

export function markManualCloseClosed(symbol) {
  db.prepare(`
    UPDATE monitored_positions
    SET status = 'closed', closed_at = CURRENT_TIMESTAMP, error_message = NULL
    WHERE symbol = ? AND status = 'exiting' AND exit_reason = 'manual_close'
  `).run(symbol);
  emitEvent('Monitor', 'monitored_manual_close_completed', `${symbol} monitored position marked closed after manual close.`, { symbol });
  broadcast('monitor_update', { symbol, status: 'closed' });
}

export function markManualCloseFailed(symbol, message) {
  db.prepare(`
    UPDATE monitored_positions
    SET status = 'manual_attention_required', error_message = ?
    WHERE symbol = ? AND status = 'exiting' AND exit_reason = 'manual_close'
  `).run(message, symbol);
  emitEvent('Monitor', 'monitored_manual_close_failed', `${symbol} manual close failed; monitored position needs attention.`, { symbol, error: message }, 'critical');
  broadcast('monitor_update', { symbol, status: 'manual_attention_required' });
}

export function monitorStatus() {
  const rows = monitoredPositions();
  return {
    running,
    intervalMs: Number(getSetting('monitored_exit_interval_ms', config.monitoredExitIntervalMs)),
    maxStaleSeconds: Number(getSetting('monitored_exit_max_stale_seconds', config.monitoredExitMaxStaleSeconds)),
    lastRunAt,
    lastError,
    open: rows.filter((row) => row.status === 'open' || row.status === 'pending_entry').length,
    stale: rows.filter((row) => row.status === 'stale').length,
    manualAttention: rows.filter((row) => row.status === 'manual_attention_required').length
  };
}

function secondsSince(value) {
  if (!value) return Infinity;
  return (Date.now() - new Date(value).getTime()) / 1000;
}

async function exitPosition(row, reason) {
  if (row.status === 'exiting' || row.exit_order_id) return;
  db.prepare("UPDATE monitored_positions SET status = 'exiting', exit_reason = ? WHERE id = ? AND status != 'exiting'")
    .run(reason, row.id);
  emitEvent('Monitor', `${reason}_triggered`, `${row.symbol} ${reason.replace('_', ' ')} triggered.`, { id: row.id, symbol: row.symbol, current_price: row.current_price }, 'warn');
  try {
    const order = row.market_type === 'crypto'
      ? await coinbaseCryptoAdapter.submitOrder({ symbol: row.symbol, side: 'sell', qty: row.qty })
      : await submitMarketExitOrder({ symbol: row.symbol, qty: row.qty });
    db.prepare(`
      UPDATE monitored_positions
      SET exit_order_id = ?, status = 'closed', closed_at = CURRENT_TIMESTAMP, error_message = NULL
      WHERE id = ?
    `).run(order.id, row.id);
    emitEvent('Orders', 'exit_order_submitted', `${row.symbol} monitored exit submitted.`, { id: row.id, orderId: order.id, reason });
  } catch (error) {
    db.prepare(`
      UPDATE monitored_positions
      SET status = 'manual_attention_required', error_message = ?
      WHERE id = ?
    `).run(error.message, row.id);
    emitEvent('Monitor', 'exit_order_failed', `${row.symbol} exit failed and needs manual attention.`, { id: row.id, error: error.message }, 'critical');
  }
}

export async function monitorTick() {
  running = true;
  lastRunAt = new Date().toISOString();
  const maxStaleSeconds = Number(getSetting('monitored_exit_max_stale_seconds', config.monitoredExitMaxStaleSeconds));
  const rows = db.prepare(`SELECT * FROM monitored_positions WHERE status IN (${activeStatuses.map(() => '?').join(',')})`).all(...activeStatuses);

  for (const row of rows) {
    try {
      const price = row.market_type === 'crypto'
        ? Number((await coinbaseCryptoAdapter.getTicker(row.symbol)).price)
        : await getLatestPrice(row.symbol);
      db.prepare(`
        UPDATE monitored_positions
        SET current_price = ?, last_checked_at = CURRENT_TIMESTAMP, status = CASE WHEN status = 'pending_entry' OR status = 'stale' THEN 'open' ELSE status END, error_message = NULL
        WHERE id = ?
      `).run(price, row.id);
      broadcast('monitor_update', { id: row.id, symbol: row.symbol, price });
      emitEvent('Monitor', 'monitor_check', `${row.symbol} monitor checked at $${price.toFixed(2)}.`, { id: row.id, symbol: row.symbol, price });
      const updated = { ...row, current_price: price };
      if (price <= Number(row.stop_loss)) await exitPosition(updated, 'stop_loss');
      if (price >= Number(row.take_profit)) await exitPosition(updated, 'take_profit');
    } catch (error) {
      lastError = error.message;
      if (secondsSince(row.last_checked_at || row.opened_at) > maxStaleSeconds) {
        db.prepare("UPDATE monitored_positions SET status = 'stale', error_message = ? WHERE id = ?")
          .run(error.message, row.id);
        emitEvent('Monitor', 'monitored_position_stale', `${row.symbol} price data is stale; new entries are blocked.`, { id: row.id, error: error.message }, 'critical');
      }
    }
  }
}

export function startMonitor() {
  if (timer) return;
  const interval = Number(getSetting('monitored_exit_interval_ms', config.monitoredExitIntervalMs));
  timer = setInterval(() => {
    monitorTick().catch((error) => {
      lastError = error.message;
      emitEvent('Monitor', 'monitor_error', error.message, {}, 'critical');
    });
  }, interval);
  emitEvent('Monitor', 'monitor_started', 'SignalFlow monitored exit service started.', { interval });
}

export async function manualExit(id) {
  const row = monitoredPosition(id);
  if (!row) throw new Error('Monitored position not found');
  if (row.status === 'closed') throw new Error('Position already closed');
  await exitPosition(row, 'manual_exit');
  return monitoredPosition(id);
}

export function markReviewed(id) {
  const row = monitoredPosition(id);
  if (!row) throw new Error('Monitored position not found');
  db.prepare("UPDATE monitored_positions SET status = CASE WHEN exit_order_id IS NULL THEN 'open' ELSE status END, error_message = NULL WHERE id = ?")
    .run(id);
  emitEvent('Monitor', 'manual_attention_reviewed', `${row.symbol} manual attention marked reviewed.`, { id });
  return monitoredPosition(id);
}
