import { nanoid } from 'nanoid';
import { db, getSetting } from './db.js';
import { latestMarketRegime } from './watchlist.js';
import { emitEvent } from './events.js';

const mistakeTags = ['chased', 'late entry', 'ignored regime', 'bad spread', 'exited early', 'stop too tight', 'target too far', 'manual override', 'system error'];

function parseJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function secondsBetween(start, end) {
  if (!start || !end) return null;
  const diff = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(diff) ? Math.max(0, Math.round(diff / 1000)) : null;
}

function latestEntryFor(symbol, closedAt) {
  return db.prepare(`
    SELECT * FROM orders
    WHERE symbol = ? AND side = 'buy' AND signal_id IS NOT NULL
    AND datetime(created_at) <= datetime(?)
    ORDER BY created_at DESC
    LIMIT 1
  `).get(symbol, closedAt);
}

function upsertSignalOutcome(signal, status = null) {
  if (!signal) return;
  const existing = db.prepare('SELECT signal_id FROM signal_outcomes WHERE signal_id = ?').get(signal.id);
  const regime = latestMarketRegime();
  const values = {
    signal_id: signal.id,
    symbol: signal.symbol,
    generated_at: signal.created_at,
    direction: signal.direction,
    confidence: Number(signal.confidence || 0),
    entry: Number(signal.entry_price || 0),
    stop_loss: Number(signal.stop_loss || 0),
    take_profit: Number(signal.take_profit || 0),
    market_regime: regime.regime || 'NEUTRAL',
    scanner_preset: getSetting('active_scanner_preset', 'manual'),
    status: status || signal.status,
    outcome_checked_at: new Date().toISOString()
  };
  if (existing) {
    db.prepare(`
      UPDATE signal_outcomes
      SET status = ?, outcome_checked_at = ?, market_regime = COALESCE(market_regime, ?), scanner_preset = COALESCE(scanner_preset, ?)
      WHERE signal_id = ?
    `).run(values.status, values.outcome_checked_at, values.market_regime, values.scanner_preset, signal.id);
  } else {
    db.prepare(`
      INSERT INTO signal_outcomes
      (signal_id, symbol, generated_at, direction, confidence, entry, stop_loss, take_profit, market_regime, scanner_preset, status, max_favorable_move, max_adverse_move, would_hit_target, would_hit_stop, outcome_checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?)
    `).run(values.signal_id, values.symbol, values.generated_at, values.direction, values.confidence, values.entry, values.stop_loss, values.take_profit, values.market_regime, values.scanner_preset, values.status, values.outcome_checked_at);
  }
}

export function syncSignalOutcomes() {
  const signals = db.prepare('SELECT * FROM signals ORDER BY created_at DESC LIMIT 500').all();
  signals.forEach((signal) => upsertSignalOutcome(signal));
}

export function recordClosedTrade({ symbol, localOrderId, exitReason, order = null, position = null, protectionMode = null }) {
  const closeRow = localOrderId ? db.prepare('SELECT * FROM orders WHERE id = ?').get(localOrderId) : null;
  const closedAt = closeRow?.updated_at || new Date().toISOString();
  const entryRow = latestEntryFor(symbol, closeRow?.created_at || closedAt);
  const signal = entryRow?.signal_id ? db.prepare('SELECT * FROM signals WHERE id = ?').get(entryRow.signal_id) : null;
  if (signal) upsertSignalOutcome(signal, 'approved');

  const closeRaw = parseJson(closeRow?.raw_json);
  const sourcePosition = position || closeRaw.position || {};
  const sourceOrder = order || closeRaw.order || {};
  const qty = Math.abs(Number(sourceOrder.filled_qty || sourceOrder.qty || sourcePosition.qty || 0));
  if (!qty) return null;

  const entryPrice = Number(signal?.entry_price || sourcePosition.avg_entry_price || sourcePosition.avg_entry || 0);
  const exitPrice = Number(sourceOrder.filled_avg_price || sourcePosition.current_price || (Number(sourcePosition.market_value || 0) / qty) || entryPrice);
  const stopLoss = Number(signal?.stop_loss || sourcePosition.stop_loss || 0);
  const takeProfit = Number(signal?.take_profit || sourcePosition.take_profit || 0);
  const realizedPnl = (exitPrice - entryPrice) * qty;
  const notional = Math.abs(exitPrice * qty);
  const riskAmount = stopLoss ? Math.abs(entryPrice - stopLoss) * qty : 0;
  const rewardAmount = takeProfit ? Math.abs(takeProfit - entryPrice) * qty : 0;
  const rrPlanned = riskAmount ? rewardAmount / riskAmount : 0;
  const rrActual = riskAmount ? realizedPnl / riskAmount : 0;
  const openedAt = entryRow?.created_at || signal?.resolved_at || signal?.created_at || closeRow?.created_at;
  const existing = closeRow ? db.prepare('SELECT * FROM trade_journal WHERE trade_id = ?').get(closeRow.id) : null;
  const marketRegime = latestMarketRegime();

  const row = {
    id: existing?.id || nanoid(),
    trade_id: closeRow?.id || localOrderId || nanoid(),
    signal_id: signal?.id || null,
    symbol,
    strategy_name: signal?.strategy || 'manual_close',
    scanner_preset: getSetting('active_scanner_preset', 'manual'),
    market_regime: marketRegime.regime || 'NEUTRAL',
    entry_price: entryPrice,
    exit_price: exitPrice,
    qty,
    notional,
    stop_loss: stopLoss,
    take_profit: takeProfit,
    realized_pnl: realizedPnl,
    realized_pnl_percent: entryPrice ? (realizedPnl / (entryPrice * qty)) * 100 : 0,
    risk_amount: riskAmount,
    reward_amount: rewardAmount,
    rr_planned: rrPlanned,
    rr_actual: rrActual,
    exit_reason: exitReason || 'manual_close',
    protection_mode: protectionMode || getSetting('protection_mode', 'auto'),
    approved_at: signal?.resolved_at || null,
    opened_at: openedAt,
    closed_at: closedAt,
    duration_seconds: secondsBetween(openedAt, closedAt),
    notes: existing?.notes || '',
    mistake_tags: existing?.mistake_tags || ''
  };

  db.prepare(`
    INSERT INTO trade_journal
    (id, trade_id, signal_id, symbol, strategy_name, scanner_preset, market_regime, entry_price, exit_price, qty, notional, stop_loss, take_profit, realized_pnl, realized_pnl_percent, risk_amount, reward_amount, rr_planned, rr_actual, exit_reason, protection_mode, approved_at, opened_at, closed_at, duration_seconds, notes, mistake_tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(trade_id) DO UPDATE SET
      exit_price = excluded.exit_price,
      qty = excluded.qty,
      notional = excluded.notional,
      realized_pnl = excluded.realized_pnl,
      realized_pnl_percent = excluded.realized_pnl_percent,
      rr_actual = excluded.rr_actual,
      exit_reason = excluded.exit_reason,
      closed_at = excluded.closed_at,
      duration_seconds = excluded.duration_seconds
  `).run(...Object.values(row));

  refreshPerformanceTables();
  emitEvent('Journal', 'trade_journal_updated', `${symbol} journal row updated.`, { tradeId: row.trade_id, symbol, pnl: row.realized_pnl });
  return row;
}

export function syncJournalFromOrders() {
  syncSignalOutcomes();
  const rows = db.prepare(`
    SELECT * FROM orders
    WHERE status IN ('close_order_filled', 'filled')
    AND side = 'sell'
    ORDER BY created_at DESC
    LIMIT 300
  `).all();
  rows.forEach((row) => {
    const raw = parseJson(row.raw_json);
    if (String(raw.reason || '').includes('manual_close') || String(row.alpaca_order_id || '').includes('manual-close')) {
      recordClosedTrade({ symbol: row.symbol, localOrderId: row.id, exitReason: raw.reason || 'manual_close', order: raw.order, position: raw.position });
    }
  });
}

export function journalRows() {
  syncJournalFromOrders();
  return db.prepare('SELECT * FROM trade_journal ORDER BY datetime(COALESCE(closed_at, created_at)) DESC').all();
}

export function updateJournalNotes(id, { notes = '', mistake_tags = [] }) {
  const row = db.prepare('SELECT * FROM trade_journal WHERE id = ?').get(id);
  if (!row) throw new Error('Journal row not found');
  const tags = Array.isArray(mistake_tags) ? mistake_tags.filter((tag) => mistakeTags.includes(tag)) : [];
  db.prepare('UPDATE trade_journal SET notes = ?, mistake_tags = ? WHERE id = ?').run(notes, JSON.stringify(tags), id);
  emitEvent('Journal', 'journal_notes_updated', `${row.symbol} journal notes updated.`, { id, tags });
  return db.prepare('SELECT * FROM trade_journal WHERE id = ?').get(id);
}

function rowsForStats() {
  return journalRows();
}

function maxDrawdown(rows) {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  [...rows].reverse().forEach((row) => {
    equity += Number(row.realized_pnl || 0);
    peak = Math.max(peak, equity);
    drawdown = Math.min(drawdown, equity - peak);
  });
  return drawdown;
}

function aggregate(rows) {
  const totalTrades = rows.length;
  const wins = rows.filter((row) => Number(row.realized_pnl) > 0);
  const losses = rows.filter((row) => Number(row.realized_pnl) < 0);
  const grossWin = wins.reduce((sum, row) => sum + Number(row.realized_pnl || 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, row) => sum + Number(row.realized_pnl || 0), 0));
  const totalPnl = rows.reduce((sum, row) => sum + Number(row.realized_pnl || 0), 0);
  return {
    totalTrades,
    wins: wins.length,
    losses: losses.length,
    winRate: totalTrades ? (wins.length / totalTrades) * 100 : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin ? Infinity : 0,
    averageWin: wins.length ? grossWin / wins.length : 0,
    averageLoss: losses.length ? -grossLoss / losses.length : 0,
    expectancy: totalTrades ? totalPnl / totalTrades : 0,
    totalPnl,
    maxDrawdown: maxDrawdown(rows)
  };
}

function groupBy(rows, key) {
  const groups = new Map();
  rows.forEach((row) => {
    const group = row[key] || 'unknown';
    groups.set(group, [...(groups.get(group) || []), row]);
  });
  return [...groups.entries()].map(([name, items]) => ({ name, ...aggregate(items) }))
    .sort((a, b) => b.totalPnl - a.totalPnl);
}

export function performanceSummary() {
  const rows = rowsForStats();
  const bySymbol = groupBy(rows, 'symbol');
  const byPreset = groupBy(rows, 'scanner_preset');
  return {
    ...aggregate(rows),
    bestSymbol: bySymbol[0] || null,
    worstSymbol: bySymbol.at(-1) || null,
    bestScannerPreset: byPreset[0] || null,
    equityCurve: [...rows].reverse().reduce((acc, row) => {
      const last = acc.at(-1)?.equity || 0;
      acc.push({ date: row.closed_at || row.created_at, equity: last + Number(row.realized_pnl || 0), pnl: Number(row.realized_pnl || 0) });
      return acc;
    }, [])
  };
}

export function performanceDaily() {
  const rows = rowsForStats();
  const groups = new Map();
  rows.forEach((row) => {
    const day = String(row.closed_at || row.created_at || '').slice(0, 10) || 'unknown';
    groups.set(day, [...(groups.get(day) || []), row]);
  });
  return [...groups.entries()].map(([day, items]) => ({ day, ...aggregate(items) })).sort((a, b) => a.day.localeCompare(b.day));
}

export function performanceStrategy() {
  return groupBy(rowsForStats(), 'strategy_name');
}

export function performanceSymbols() {
  return groupBy(rowsForStats(), 'symbol');
}

export function signalOutcomes() {
  syncSignalOutcomes();
  return db.prepare('SELECT * FROM signal_outcomes ORDER BY generated_at DESC LIMIT 500').all();
}

export function refreshPerformanceTables() {
  const daily = performanceDaily();
  db.prepare('DELETE FROM performance_daily').run();
  daily.forEach((row) => {
    db.prepare('INSERT INTO performance_daily (day, trades, wins, losses, realized_pnl, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)')
      .run(row.day, row.totalTrades, row.wins, row.losses, row.totalPnl);
  });
  const strategies = performanceStrategy();
  db.prepare('DELETE FROM strategy_stats').run();
  strategies.forEach((row) => {
    db.prepare('INSERT INTO strategy_stats (strategy_name, trades, wins, losses, realized_pnl, profit_factor, expectancy, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)')
      .run(row.name, row.totalTrades, row.wins, row.losses, row.totalPnl, Number.isFinite(row.profitFactor) ? row.profitFactor : 999, row.expectancy);
  });
}

export { mistakeTags };
