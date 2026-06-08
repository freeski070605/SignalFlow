import { nanoid } from 'nanoid';
import { config } from './config.js';
import { collections, getSetting, nowIso, withoutMongoId, withoutMongoIds } from './db.js';
import { getLatestPrice, submitMarketExitOrder } from './alpaca.js';
import { coinbaseCryptoAdapter } from './adapters/coinbaseCryptoAdapter.js';
import { emitEvent } from './events.js';
import { broadcast } from './ws.js';

let timer = null;
let running = false;
let lastRunAt = null;
let lastError = null;

const activeStatuses = ['pending_entry', 'open', 'stale'];

export async function createMonitoredPosition({ symbol, order, signal, notional, qty, marketType = signal?.market_type || 'stocks', exchange = signal?.exchange || 'alpaca', adapterName = signal?.adapter_name || exchange }) {
  const id = nanoid();
  const [baseAsset, quoteAsset = 'USD'] = symbol.includes('-') ? symbol.split('-') : [symbol, 'USD'];
  await collections.monitoredPositions.insertOne({
    id,
    market_type: marketType,
    exchange,
    adapter_name: adapterName,
    symbol,
    base_asset: baseAsset,
    quote_asset: quoteAsset,
    product_id: symbol,
    side: 'long',
    alpaca_order_id: order.id,
    entry_order_id: order.id,
    qty: Number(qty),
    notional: Number(notional),
    entry_price: Number(signal.entry_price),
    stop_loss: Number(signal.stop_loss),
    take_profit: Number(signal.take_profit),
    current_price: Number(signal.entry_price),
    status: 'pending_entry',
    opened_at: nowIso()
  });
  emitEvent('Monitor', 'protection_assigned', `${symbol} assigned SignalFlow monitored exits.`, { id, symbol, stop_loss: signal.stop_loss, take_profit: signal.take_profit });
  return id;
}

export async function monitoredPositions() {
  const rows = await collections.monitoredPositions.find({}).sort({ opened_at: -1 }).toArray();
  return withoutMongoIds(rows);
}

export async function monitoredPosition(id) {
  return withoutMongoId(await collections.monitoredPositions.findOne({ id }));
}

export async function activeMonitoredPositionForSymbol(symbol) {
  return withoutMongoId(await collections.monitoredPositions.findOne(
    { symbol, status: { $in: ['pending_entry', 'open', 'stale', 'manual_attention_required'] } },
    { sort: { opened_at: -1 } }
  ));
}

export async function markManualCloseInProgress(symbol) {
  const row = await activeMonitoredPositionForSymbol(symbol);
  if (!row) return null;
  await collections.monitoredPositions.updateOne({ id: row.id }, { $set: { status: 'exiting', exit_reason: 'manual_close', error_message: null } });
  emitEvent('Monitor', 'monitored_manual_close_started', `${symbol} monitored position marked exiting for manual close.`, { id: row.id, symbol }, 'warn');
  broadcast('monitor_update', { id: row.id, symbol, status: 'exiting' });
  return monitoredPosition(row.id);
}

export async function markManualCloseClosed(symbol) {
  await collections.monitoredPositions.updateMany(
    { symbol, status: 'exiting', exit_reason: 'manual_close' },
    { $set: { status: 'closed', closed_at: nowIso(), error_message: null } }
  );
  emitEvent('Monitor', 'monitored_manual_close_completed', `${symbol} monitored position marked closed after manual close.`, { symbol });
  broadcast('monitor_update', { symbol, status: 'closed' });
}

export async function markManualCloseFailed(symbol, message) {
  await collections.monitoredPositions.updateMany(
    { symbol, status: 'exiting', exit_reason: 'manual_close' },
    { $set: { status: 'manual_attention_required', error_message: message } }
  );
  emitEvent('Monitor', 'monitored_manual_close_failed', `${symbol} manual close failed; monitored position needs attention.`, { symbol, error: message }, 'critical');
  broadcast('monitor_update', { symbol, status: 'manual_attention_required' });
}

export async function monitorStatus() {
  const rows = await monitoredPositions();
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
  await collections.monitoredPositions.updateOne({ id: row.id, status: { $ne: 'exiting' } }, { $set: { status: 'exiting', exit_reason: reason } });
  emitEvent('Monitor', `${reason}_triggered`, `${row.symbol} ${reason.replace('_', ' ')} triggered.`, { id: row.id, symbol: row.symbol, current_price: row.current_price }, 'warn');
  try {
    const order = row.market_type === 'crypto'
      ? await coinbaseCryptoAdapter.submitOrder({ symbol: row.symbol, side: 'sell', qty: row.qty })
      : await submitMarketExitOrder({ symbol: row.symbol, qty: row.qty });
    await collections.monitoredPositions.updateOne(
      { id: row.id },
      { $set: { exit_order_id: order.id, status: 'closed', closed_at: nowIso(), error_message: null } }
    );
    emitEvent('Orders', 'exit_order_submitted', `${row.symbol} monitored exit submitted.`, { id: row.id, orderId: order.id, reason });
  } catch (error) {
    await collections.monitoredPositions.updateOne(
      { id: row.id },
      { $set: { status: 'manual_attention_required', error_message: error.message } }
    );
    emitEvent('Monitor', 'exit_order_failed', `${row.symbol} exit failed and needs manual attention.`, { id: row.id, error: error.message }, 'critical');
  }
}

export async function monitorTick() {
  running = true;
  lastRunAt = new Date().toISOString();
  const maxStaleSeconds = Number(getSetting('monitored_exit_max_stale_seconds', config.monitoredExitMaxStaleSeconds));
  const rows = withoutMongoIds(await collections.monitoredPositions.find({ status: { $in: activeStatuses } }).toArray());

  for (const row of rows) {
    try {
      const price = row.market_type === 'crypto'
        ? Number((await coinbaseCryptoAdapter.getTicker(row.symbol)).price)
        : await getLatestPrice(row.symbol);
      await collections.monitoredPositions.updateOne(
        { id: row.id },
        { $set: { current_price: price, last_checked_at: nowIso(), status: ['pending_entry', 'stale'].includes(row.status) ? 'open' : row.status, error_message: null } }
      );
      broadcast('monitor_update', { id: row.id, symbol: row.symbol, price });
      emitEvent('Monitor', 'monitor_check', `${row.symbol} monitor checked at $${price.toFixed(2)}.`, { id: row.id, symbol: row.symbol, price });
      const updated = { ...row, current_price: price };
      if (price <= Number(row.stop_loss)) await exitPosition(updated, 'stop_loss');
      if (price >= Number(row.take_profit)) await exitPosition(updated, 'take_profit');
    } catch (error) {
      lastError = error.message;
      if (secondsSince(row.last_checked_at || row.opened_at) > maxStaleSeconds) {
        await collections.monitoredPositions.updateOne({ id: row.id }, { $set: { status: 'stale', error_message: error.message } });
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
  const row = await monitoredPosition(id);
  if (!row) throw new Error('Monitored position not found');
  if (row.status === 'closed') throw new Error('Position already closed');
  await exitPosition(row, 'manual_exit');
  return monitoredPosition(id);
}

export async function markReviewed(id) {
  const row = await monitoredPosition(id);
  if (!row) throw new Error('Monitored position not found');
  await collections.monitoredPositions.updateOne(
    { id },
    { $set: { status: row.exit_order_id ? row.status : 'open', error_message: null } }
  );
  emitEvent('Monitor', 'manual_attention_reviewed', `${row.symbol} manual attention marked reviewed.`, { id });
  return monitoredPosition(id);
}
