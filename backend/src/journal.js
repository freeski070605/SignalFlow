import { nanoid } from 'nanoid';
import { collections, getSetting, nowIso, withoutMongoId, withoutMongoIds } from './db.js';
import { latestMarketRegime } from './watchlist.js';
import { emitEvent } from './events.js';
import { coinbaseCryptoAdapter } from './adapters/coinbaseCryptoAdapter.js';

const mistakeTags = ['chased', 'late entry', 'ignored regime', 'bad spread', 'exited early', 'stop too tight', 'target too far', 'manual override', 'system error'];
let outcomeTimer = null;
let outcomeAnalysisInFlight = false;

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

async function latestEntryFor(symbol, closedAt) {
  return withoutMongoId(await collections.orders.findOne(
    { symbol, side: 'buy', signal_id: { $ne: null }, created_at: { $lte: closedAt } },
    { sort: { created_at: -1 } }
  ));
}

async function upsertSignalOutcome(signal, status = null) {
  if (!signal) return;
  const regime = await latestMarketRegime();
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
    outcome_checked_at: nowIso()
  };
  await collections.signalOutcomes.updateOne(
    { signal_id: signal.id },
    {
      $set: values,
      $setOnInsert: {
        outcome: 'pending_analysis',
        max_favorable_excursion: 0,
        max_adverse_excursion: 0,
        max_favorable_move: 0,
        max_adverse_move: 0,
        would_hit_target: false,
        would_hit_stop: false,
        target_hit_first: false,
        stop_hit_first: false,
        outcome_grade: null
      }
    },
    { upsert: true }
  );
}

export async function syncSignalOutcomes() {
  const signals = withoutMongoIds(await collections.signals.find({}).sort({ created_at: -1 }).limit(500).toArray());
  await Promise.all(signals.map((signal) => upsertSignalOutcome(signal)));
  await analyzeExpiredSignalOutcomes({ limit: 100 });
}

const toMs = (value) => {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
};

const pctChange = (from, to) => {
  const base = Number(from || 0);
  const next = Number(to || 0);
  return base ? ((next - base) / base) * 100 : 0;
};

function candleHits(signal, candle) {
  const direction = signal.direction || 'BUY';
  const target = Number(signal.take_profit || 0);
  const stop = Number(signal.stop_loss || 0);
  if (direction === 'SELL') {
    return {
      target: target ? Number(candle.low || 0) <= target : false,
      stop: stop ? Number(candle.high || 0) >= stop : false
    };
  }
  return {
    target: target ? Number(candle.high || 0) >= target : false,
    stop: stop ? Number(candle.low || 0) <= stop : false
  };
}

function candleExcursions(signal, candle) {
  const entry = Number(signal.entry_price || signal.signal_price || 0);
  if (signal.direction === 'SELL') {
    return {
      favorable: entry ? ((entry - Number(candle.low || 0)) / entry) * 100 : 0,
      adverse: entry ? ((entry - Number(candle.high || 0)) / entry) * 100 : 0
    };
  }
  return {
    favorable: pctChange(entry, Number(candle.high || 0)),
    adverse: pctChange(entry, Number(candle.low || 0))
  };
}

function gradeOutcome({ targetHitFirst, stopHitFirst, immediateStopHit, maxAdverseExcursion }) {
  if (stopHitFirst) return immediateStopHit ? 'F' : 'D';
  if (targetHitFirst) return Number(maxAdverseExcursion || 0) < 0 ? 'B' : 'A';
  return 'C';
}

function outcomeLabel({ targetHitFirst, stopHitFirst, targetHit, stopHit }) {
  if (targetHitFirst) return 'would_win';
  if (stopHitFirst) return 'would_loss';
  if (targetHit) return 'target_hit';
  if (stopHit) return 'stop_hit';
  return 'no_hit';
}

async function candlesAfterSignal(signal) {
  const generatedAt = signal.created_at || signal.generated_at;
  const ageMs = Date.now() - toMs(generatedAt);
  const timeframe = ageMs <= 300 * 60 * 1000 ? '1m' : '5m';
  const candles = await coinbaseCryptoAdapter.getCandles(signal.symbol, timeframe, {
    start: generatedAt,
    end: nowIso(),
    limit: 300
  });
  return candles.filter((row) => toMs(row.timestamp) >= toMs(generatedAt));
}

export async function analyzeExpiredSignalOutcome(signal) {
  if (!signal || signal.status !== 'expired') return null;
  await upsertSignalOutcome(signal, signal.status);

  const entry = Number(signal.entry_price || signal.signal_price || 0);
  if (signal.market_type !== 'crypto') {
    await collections.signalOutcomes.updateOne(
      { signal_id: signal.id },
      { $set: { outcome: 'unsupported_market', outcome_checked_at: nowIso() } }
    );
    return withoutMongoId(await collections.signalOutcomes.findOne({ signal_id: signal.id }));
  }
  if (!entry || !Number(signal.stop_loss || 0) || !Number(signal.take_profit || 0)) {
    await collections.signalOutcomes.updateOne(
      { signal_id: signal.id },
      { $set: { outcome: 'missing_levels', outcome_checked_at: nowIso() } }
    );
    return withoutMongoId(await collections.signalOutcomes.findOne({ signal_id: signal.id }));
  }

  const candles = await candlesAfterSignal(signal);
  if (!candles.length) {
    await collections.signalOutcomes.updateOne(
      { signal_id: signal.id },
      { $set: { outcome: 'waiting_for_candles', outcome_checked_at: nowIso() } }
    );
    return withoutMongoId(await collections.signalOutcomes.findOne({ signal_id: signal.id }));
  }

  let maxFavorableExcursion = 0;
  let maxAdverseExcursion = 0;
  let maxAdverseBeforeTarget = 0;
  let targetHitAt = null;
  let stopHitAt = null;

  for (const candle of candles) {
    const { favorable, adverse } = candleExcursions(signal, candle);
    maxFavorableExcursion = Math.max(maxFavorableExcursion, favorable);
    maxAdverseExcursion = Math.min(maxAdverseExcursion, adverse);
    if (!targetHitAt) maxAdverseBeforeTarget = Math.min(maxAdverseBeforeTarget, adverse);

    const hits = candleHits(signal, candle);
    if (hits.target && !targetHitAt) targetHitAt = candle.timestamp;
    if (hits.stop && !stopHitAt) stopHitAt = candle.timestamp;
  }

  const targetMs = toMs(targetHitAt);
  const stopMs = toMs(stopHitAt);
  const targetHitFirst = Boolean(targetHitAt && (!stopHitAt || targetMs < stopMs));
  const stopHitFirst = Boolean(stopHitAt && (!targetHitAt || stopMs <= targetMs));
  const immediateStopHit = Boolean(stopHitFirst && stopHitAt === candles[0]?.timestamp);
  const outcome = outcomeLabel({
    targetHitFirst,
    stopHitFirst,
    targetHit: Boolean(targetHitAt),
    stopHit: Boolean(stopHitAt)
  });
  const outcomeGrade = gradeOutcome({
    targetHitFirst,
    stopHitFirst,
    immediateStopHit,
    maxAdverseExcursion: maxAdverseBeforeTarget
  });
  const checkedAt = nowIso();

  await collections.signalOutcomes.updateOne(
    { signal_id: signal.id },
    {
      $set: {
        outcome,
        max_favorable_excursion: maxFavorableExcursion,
        max_adverse_excursion: maxAdverseExcursion,
        max_adverse_before_target: maxAdverseBeforeTarget,
        max_favorable_move: maxFavorableExcursion,
        max_adverse_move: maxAdverseExcursion,
        would_hit_target: Boolean(targetHitAt),
        would_hit_stop: Boolean(stopHitAt),
        target_hit_first: targetHitFirst,
        stop_hit_first: stopHitFirst,
        target_hit_at: targetHitAt,
        stop_hit_at: stopHitAt,
        outcome_grade: outcomeGrade,
        outcome_checked_at: checkedAt,
        analysis_window_start: candles[0]?.timestamp || signal.created_at,
        analysis_window_end: candles.at(-1)?.timestamp || checkedAt,
        analysis_candle_count: candles.length
      }
    },
    { upsert: true }
  );
  return withoutMongoId(await collections.signalOutcomes.findOne({ signal_id: signal.id }));
}

export async function analyzeExpiredSignalOutcomes({ limit = 50 } = {}) {
  if (outcomeAnalysisInFlight) return;
  outcomeAnalysisInFlight = true;
  try {
    const rows = withoutMongoIds(await collections.signals.find({ status: 'expired' }).sort({ expired_at: -1, created_at: -1 }).limit(limit).toArray());
    for (const signal of rows) {
      try {
        await analyzeExpiredSignalOutcome(signal);
      } catch (error) {
        await collections.signalOutcomes.updateOne(
          { signal_id: signal.id },
          { $set: { outcome: 'analysis_error', analysis_error: error.message, outcome_checked_at: nowIso() } },
          { upsert: true }
        );
        emitEvent('Journal', 'signal_outcome_analysis_failed', `${signal.symbol} outcome analysis failed: ${error.message}`, { signalId: signal.id, symbol: signal.symbol }, 'warn');
      }
    }
  } finally {
    outcomeAnalysisInFlight = false;
  }
}

export function startSignalOutcomeAnalysisJob() {
  if (outcomeTimer) return;
  outcomeTimer = setInterval(() => {
    analyzeExpiredSignalOutcomes({ limit: 50 }).catch((error) => {
      emitEvent('Journal', 'signal_outcome_analysis_job_failed', error.message, {}, 'warn');
    });
  }, 60_000);
  emitEvent('Journal', 'signal_outcome_analysis_job_started', 'Signal outcome analysis job started.', { intervalMs: 60_000 });
}

export async function recordClosedTrade({ symbol, localOrderId, exitReason, order = null, position = null, protectionMode = null }) {
  const closeRow = localOrderId ? withoutMongoId(await collections.orders.findOne({ id: localOrderId })) : null;
  const closedAt = closeRow?.updated_at || nowIso();
  const entryRow = await latestEntryFor(symbol, closeRow?.created_at || closedAt);
  const signal = entryRow?.signal_id ? withoutMongoId(await collections.signals.findOne({ id: entryRow.signal_id })) : null;
  if (signal) await upsertSignalOutcome(signal, 'approved');

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
  const existing = closeRow ? withoutMongoId(await collections.tradeJournal.findOne({ trade_id: closeRow.id })) : null;
  const marketRegime = await latestMarketRegime();

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

  await collections.tradeJournal.updateOne(
    { trade_id: row.trade_id },
    { $set: { ...row, created_at: existing?.created_at || nowIso() } },
    { upsert: true }
  );

  await refreshPerformanceTables();
  emitEvent('Journal', 'trade_journal_updated', `${symbol} journal row updated.`, { tradeId: row.trade_id, symbol, pnl: row.realized_pnl });
  return row;
}

export async function syncJournalFromOrders() {
  await syncSignalOutcomes();
  const rows = withoutMongoIds(await collections.orders.find({ status: { $in: ['close_order_filled', 'filled'] }, side: 'sell' }).sort({ created_at: -1 }).limit(300).toArray());
  for (const row of rows) {
    const raw = parseJson(row.raw_json);
    if (String(raw.reason || '').includes('manual_close') || String(row.alpaca_order_id || '').includes('manual-close')) {
      await recordClosedTrade({ symbol: row.symbol, localOrderId: row.id, exitReason: raw.reason || 'manual_close', order: raw.order, position: raw.position });
    }
  }
}

export async function journalRows() {
  await syncJournalFromOrders();
  const rows = withoutMongoIds(await collections.tradeJournal.find({}).toArray());
  return rows.sort((a, b) => String(b.closed_at || b.created_at || '').localeCompare(String(a.closed_at || a.created_at || '')));
}

export async function updateJournalNotes(id, { notes = '', mistake_tags = [] }) {
  const row = withoutMongoId(await collections.tradeJournal.findOne({ id }));
  if (!row) throw new Error('Journal row not found');
  const tags = Array.isArray(mistake_tags) ? mistake_tags.filter((tag) => mistakeTags.includes(tag)) : [];
  await collections.tradeJournal.updateOne({ id }, { $set: { notes, mistake_tags: JSON.stringify(tags) } });
  emitEvent('Journal', 'journal_notes_updated', `${row.symbol} journal notes updated.`, { id, tags });
  return withoutMongoId(await collections.tradeJournal.findOne({ id }));
}

async function rowsForStats() {
  const rows = withoutMongoIds(await collections.tradeJournal.find({}).toArray());
  return rows.sort((a, b) => String(b.closed_at || b.created_at || '').localeCompare(String(a.closed_at || a.created_at || '')));
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

export async function performanceSummary() {
  const rows = await rowsForStats();
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

export async function performanceDaily() {
  const rows = await rowsForStats();
  const groups = new Map();
  rows.forEach((row) => {
    const day = String(row.closed_at || row.created_at || '').slice(0, 10) || 'unknown';
    groups.set(day, [...(groups.get(day) || []), row]);
  });
  return [...groups.entries()].map(([day, items]) => ({ day, ...aggregate(items) })).sort((a, b) => a.day.localeCompare(b.day));
}

export async function performanceStrategy() {
  return groupBy(await rowsForStats(), 'strategy_name');
}

export async function performanceSymbols() {
  return groupBy(await rowsForStats(), 'symbol');
}

export async function signalOutcomes() {
  await syncSignalOutcomes();
  const rows = withoutMongoIds(await collections.signalOutcomes.find({}).sort({ generated_at: -1 }).limit(500).toArray());
  const expiredRows = rows.filter((row) => row.status === 'expired');
  const wouldHaveWon = expiredRows.filter((row) => row.target_hit_first).length;
  const wouldHaveLost = expiredRows.filter((row) => row.stop_hit_first).length;
  const resolved = wouldHaveWon + wouldHaveLost;
  return {
    rows,
    stats: {
      expiredSignals: expiredRows.length,
      wouldHaveWon,
      wouldHaveLost,
      winRateIfApproved: resolved ? (wouldHaveWon / resolved) * 100 : 0
    }
  };
}

export async function refreshPerformanceTables() {
  const daily = await performanceDaily();
  await collections.performanceDaily.deleteMany({});
  if (daily.length) {
    await collections.performanceDaily.insertMany(daily.map((row) => ({ day: row.day, trades: row.totalTrades, wins: row.wins, losses: row.losses, realized_pnl: row.totalPnl, updated_at: nowIso() })));
  }
  const strategies = await performanceStrategy();
  await collections.strategyStats.deleteMany({});
  if (strategies.length) {
    await collections.strategyStats.insertMany(strategies.map((row) => ({ strategy_name: row.name, trades: row.totalTrades, wins: row.wins, losses: row.losses, realized_pnl: row.totalPnl, profit_factor: Number.isFinite(row.profitFactor) ? row.profitFactor : 999, expectancy: row.expectancy, updated_at: nowIso() })));
  }
}

export { mistakeTags };
