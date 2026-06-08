import http from 'node:http';
import cors from 'cors';
import express from 'express';
import { nanoid } from 'nanoid';
import { config, executionMode } from './config.js';
import { allSettings, collections, getSetting, logEvent, migrate, nowIso, setSetting, withoutMongoId, withoutMongoIds } from './db.js';
import { cancelOrder, closePosition, getAccount, getAsset, getMarketClock, getOrders, getPositions, submitBracketNotionalOrder, submitMarketExitOrder, submitSimpleNotionalBuyOrder } from './alpaca.js';
import { emitEvent, recentEvents } from './events.js';
import { journalRows, mistakeTags, performanceDaily, performanceStrategy, performanceSummary, performanceSymbols, recordClosedTrade, signalOutcomes, updateJournalNotes } from './journal.js';
import { createMonitoredPosition, manualExit, markManualCloseClosed, markManualCloseFailed, markManualCloseInProgress, markReviewed, monitoredPosition, monitoredPositions, monitorStatus, startMonitor } from './monitor.js';
import { evaluateRisk } from './risk.js';
import { evaluateCryptoRisk } from './cryptoRisk.js';
import { coinbaseCryptoAdapter } from './adapters/coinbaseCryptoAdapter.js';
import { cryptoMarketRegime, cryptoScannerSettingsPayload, cryptoStrategySettingsPayload, debugCryptoSignal, nearMissAnalytics, runCryptoScanner, saveCryptoScannerSettings, saveCryptoStrategySettings, simulateCryptoSignalModes } from './cryptoScanner.js';
import { pctMove, secondsRemaining, startSignalExpirationJob, validateSignalBeforeApproval } from './signals.js';
import {
  blockedSymbols,
  getMarketRegime,
  latestMarketRegime,
  latestTradingUniverse,
  relaxScannerSettings,
  runTradingUniverseScanner,
  safeMarketRow,
  scanContextWatchlist,
  saveScannerSettings,
  scannerRun,
  scannerRuns,
  scannerSettingsPayload,
  scannerSettings,
  scanWatchlist
} from './watchlist.js';
import { attachWebSocket, broadcast } from './ws.js';

await migrate();

const app = express();
app.use(cors({ origin: config.frontendOrigin }));
app.use(express.json());

const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

const openOrderStatuses = new Set(['new', 'accepted', 'pending_new', 'partially_filled', 'held', 'accepted_for_bidding', 'pending_replace', 'pending_cancel', 'calculated', 'submitted']);
const activeCloseSymbols = new Set();
const closeLifecycleStatuses = new Set(['cancelling_open_orders', 'submitting_close_order', 'close_order_submitted']);
let cryptoScannerTimer = null;
let cryptoScannerInFlight = false;
let cryptoScannerLastRun = null;
let cryptoScannerLastError = null;
let cryptoScannerNextRunAt = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const boolSetting = (key, fallback) => String(getSetting(key, fallback)).toLowerCase() === 'true';
const numSetting = (key, fallback) => {
  const parsed = Number(getSetting(key, fallback));
  return Number.isFinite(parsed) ? parsed : fallback;
};

function autoCryptoScannerConfig() {
  return {
    enabled: boolSetting('auto_crypto_scanner', config.autoCryptoScanner),
    intervalMs: Math.max(15000, numSetting('crypto_scanner_interval_ms', config.cryptoScannerIntervalMs))
  };
}

async function runScheduledCryptoScanner() {
  const scannerConfig = autoCryptoScannerConfig();
  if (!scannerConfig.enabled || cryptoScannerInFlight) return;
  cryptoScannerInFlight = true;
  cryptoScannerLastError = null;
  try {
    const result = await runCryptoScanner({});
    cryptoScannerLastRun = {
      runId: result.runId,
      completedAt: new Date().toISOString(),
      passed: result.passed?.length || 0,
      rejected: result.rejected?.length || 0,
      nearMisses: result.opportunityMonitor?.nearMisses?.length || 0,
      alerts: result.opportunityAlerts?.length || 0
    };
    broadcast('scanner_run', result);
  } catch (error) {
    cryptoScannerLastError = { message: error.message, at: new Date().toISOString() };
    emitEvent('Scanner', 'auto_crypto_scanner_failed', `Auto crypto scanner failed: ${error.message}`, { message: error.message }, 'warn');
  } finally {
    cryptoScannerInFlight = false;
    const nextConfig = autoCryptoScannerConfig();
    cryptoScannerNextRunAt = nextConfig.enabled ? new Date(Date.now() + nextConfig.intervalMs).toISOString() : null;
  }
}

function startAutoCryptoScanner() {
  const scannerConfig = autoCryptoScannerConfig();
  if (cryptoScannerTimer || !scannerConfig.enabled || scannerConfig.intervalMs <= 0) {
    cryptoScannerNextRunAt = null;
    return;
  }
  cryptoScannerNextRunAt = new Date(Date.now() + 5000).toISOString();
  emitEvent('Scanner', 'auto_crypto_scanner_started', 'Auto crypto scanner started.', { intervalMs: scannerConfig.intervalMs });
  setTimeout(() => runScheduledCryptoScanner(), 5000);
  cryptoScannerTimer = setInterval(() => {
    const currentConfig = autoCryptoScannerConfig();
    cryptoScannerNextRunAt = currentConfig.enabled ? new Date(Date.now() + currentConfig.intervalMs).toISOString() : null;
    runScheduledCryptoScanner();
  }, scannerConfig.intervalMs);
}

function restartAutoCryptoScanner() {
  if (cryptoScannerTimer) {
    clearInterval(cryptoScannerTimer);
    cryptoScannerTimer = null;
  }
  const scannerConfig = autoCryptoScannerConfig();
  if (!scannerConfig.enabled) {
    cryptoScannerNextRunAt = null;
    emitEvent('Scanner', 'auto_crypto_scanner_stopped', 'Auto crypto scanner stopped.', {});
    return;
  }
  startAutoCryptoScanner();
}

function autoCryptoScannerStatus() {
  const scannerConfig = autoCryptoScannerConfig();
  return {
    enabled: scannerConfig.enabled,
    intervalMs: scannerConfig.intervalMs,
    inFlight: cryptoScannerInFlight,
    lastRun: cryptoScannerLastRun,
    lastError: cryptoScannerLastError,
    nextRunAt: cryptoScannerNextRunAt
  };
}

async function syncLocalOrderStatuses(liveOrders) {
  const liveById = new Map((liveOrders || []).map((order) => [order.id, order]));
  const localRows = withoutMongoIds(await collections.orders.find({}, { projection: { id: 1, alpaca_order_id: 1, symbol: 1, side: 1, status: 1, raw_json: 1 } }).sort({ created_at: -1 }).limit(200).toArray());

  for (const local of localRows) {
    const live = liveById.get(local.alpaca_order_id);
    if (!live?.status) continue;
    if (live.status !== local.status) {
      let raw = live;
      try {
        const existing = local.raw_json ? JSON.parse(local.raw_json) : null;
        if (existing?.reason === 'manual_close') raw = { ...existing, live_order: live };
      } catch {
        raw = live;
      }
      await collections.orders.updateOne({ id: local.id }, { $set: { status: live.status, raw_json: JSON.stringify(raw), updated_at: nowIso() } });
      if (local.side === 'sell' && live.status === 'filled' && JSON.stringify(raw).includes('"manual_close"')) {
        await recordClosedTrade({ symbol: local.symbol, localOrderId: local.id, exitReason: 'manual_close', order: live, position: raw.position, protectionMode: getSetting('protection_mode', 'auto') });
      }
      emitEvent('Orders', 'order_status_updated', `${live.symbol} order status updated to ${live.status}.`, {
        localOrderId: local.id,
        alpacaOrderId: live.id,
        previousStatus: local.status,
        status: live.status
      });
    }
  }
}

async function cancelOpenOrdersForSymbol(symbol, liveOrders) {
  const matches = (liveOrders || []).filter((order) => (
    order.symbol === symbol
    && openOrderStatuses.has(order.status)
  ));
  const results = [];
  for (const order of matches) {
    try {
      await cancelOrder(order.id);
      results.push({ id: order.id, status: order.status, canceled: true });
    } catch (error) {
      const message = error.message || '';
      const ignorable = /not found|already canceled|404|422/i.test(message);
      results.push({ id: order.id, status: order.status, canceled: ignorable, ignored: ignorable, error: message });
      if (!ignorable) throw error;
    }
  }
  return results;
}

async function hasActiveManualClose(symbol) {
  if (activeCloseSymbols.has(symbol)) return true;
  const rows = await collections.orders.find({ symbol }, { projection: { status: 1, raw_json: 1 } }).sort({ created_at: -1 }).limit(20).toArray();
  return rows.some((row) => (
    closeLifecycleStatuses.has(row.status)
    && String(row.raw_json || '').includes('"reason":"manual_close"')
  ));
}

function readableOrder(order) {
  if (!order) return null;
  return {
    id: order.id || null,
    symbol: order.symbol || null,
    side: order.side || null,
    qty: order.qty || null,
    notional: order.notional || null,
    status: order.status || null,
    submitted_at: order.submitted_at || null,
    filled_at: order.filled_at || null,
    filled_qty: order.filled_qty || null,
    filled_avg_price: order.filled_avg_price || null,
    order_class: order.order_class || null,
    type: order.type || order.order_type || null
  };
}

async function waitForOpenOrderCancellations(symbol) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await sleep(350);
    const liveOrders = await getOrders();
    const stillOpen = liveOrders.filter((order) => (
      order.symbol === symbol
      && openOrderStatuses.has(order.status)
    ));
    if (stillOpen.length === 0) return { ok: true, stillOpen: [] };
    if (attempt === 3) return { ok: false, stillOpen: stillOpen.map(readableOrder) };
  }
  return { ok: false, stillOpen: [] };
}

async function waitForPositionClosed(symbol, isCrypto = false) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await sleep(500);
    const positions = isCrypto ? await coinbaseCryptoAdapter.getOpenPositions() : await getPositions();
    const position = positions.find((row) => row.symbol === symbol);
    if (!position) return true;
  }
  return false;
}

app.get('/api/account', asyncHandler(async (_req, res) => {
  if (config.primaryMarket === 'crypto') {
    const [account, balances, positions, regime] = await Promise.all([
      coinbaseCryptoAdapter.getAccount(),
      coinbaseCryptoAdapter.getBalances().catch(() => []),
      coinbaseCryptoAdapter.getOpenPositions().catch(() => []),
      cryptoMarketRegime().catch(() => ({ regime: 'NEUTRAL', context: [] }))
    ]);
    const usd = balances.find((row) => row.asset === 'USD');
    res.json({
      account: { status: account.status, cash: usd?.available || 0, equity: usd?.available || 0, buying_power: usd?.available || 0 },
      balances,
      todayPnl: 0,
      mode: executionMode(),
      tradingMode: config.tradingMode,
      primaryMarket: 'crypto',
      activeExchange: 'coinbase',
      autoExecutionEnv: config.autoExecution && config.cryptoAutoExecution,
      signalReviewRequired: config.requireFreshReviewBeforeApproval,
      autoCryptoScanner: autoCryptoScannerStatus(),
      settings: allSettings(),
      sizing: { protectionMode: 'signalflow_monitor' },
      marketRegime: regime,
      credentialStatus: account.status
    });
    return;
  }
  const account = await getAccount();
  const positions = await getPositions();
  const todayPnl = positions.reduce((sum, item) => sum + Number(item.unrealized_pl || 0), 0);
  const settings = allSettings();
  const equity = Number(account.equity || 0);
  const riskPerTradeDollars = equity * (Number(settings.risk_per_trade_percent || config.riskPerTradePercent) / 100);
  const maxPositionDollars = equity * (Number(settings.max_account_position_percent || config.maxAccountPositionPercent) / 100);
  const maxDailyLossDollars = equity * (Number(settings.max_daily_loss_percent || config.maxDailyLossPercent) / 100);
  const openRisk = positions.reduce((sum, item) => sum + Math.max(0, -Number(item.unrealized_pl || 0)), 0);
  res.json({
    account,
    todayPnl,
    mode: executionMode(),
    tradingMode: config.tradingMode,
    autoExecutionEnv: config.autoExecution,
    signalReviewRequired: config.requireFreshReviewBeforeApproval,
    autoCryptoScanner: autoCryptoScannerStatus(),
    settings,
    sizing: { riskPerTradeDollars, maxPositionDollars, maxDailyLossDollars, openRisk, protectionMode: settings.protection_mode || config.protectionMode },
    marketRegime: await latestMarketRegime()
  });
}));

app.get('/api/positions', asyncHandler(async (_req, res) => {
  if (config.primaryMarket === 'crypto') {
    const positions = await coinbaseCryptoAdapter.getOpenPositions().catch(() => []);
    res.json(positions);
    return;
  }
  const positions = await getPositions();
  res.json(positions);
}));

app.get('/api/crypto/dashboard', asyncHandler(async (_req, res) => {
  const [account, balances, positions, regime, scannerSettings] = await Promise.all([
    coinbaseCryptoAdapter.getAccount(),
    coinbaseCryptoAdapter.getBalances().catch(() => []),
    coinbaseCryptoAdapter.getOpenPositions().catch(() => []),
    cryptoMarketRegime().catch((error) => ({ regime: 'NEUTRAL', error: error.message, context: [] })),
    Promise.resolve(cryptoScannerSettingsPayload())
  ]);
  const usd = balances.find((row) => row.asset === 'USD');
  res.json({
    account,
    balances,
    usdBalance: usd?.available || 0,
    positions,
    regime,
    scannerSettings,
    marketType: 'crypto',
    exchange: 'coinbase',
    quoteCurrency: 'USD',
    trading24x7: true,
    monitor: await monitorStatus(),
    autoCryptoScanner: autoCryptoScannerStatus()
  });
}));

app.get('/api/crypto/scanner/settings', (_req, res) => {
  res.json(cryptoScannerSettingsPayload());
});

app.post('/api/crypto/scanner/settings', (req, res) => {
  res.json({ settings: saveCryptoScannerSettings(req.body || {}), presets: cryptoScannerSettingsPayload().presets });
});

app.get('/api/crypto/strategy-settings', (_req, res) => {
  res.json(cryptoStrategySettingsPayload());
});

app.post('/api/crypto/strategy-settings', (req, res) => {
  res.json({ settings: saveCryptoStrategySettings(req.body || {}), presets: cryptoStrategySettingsPayload().presets });
});

app.post('/api/crypto/scanner/run', asyncHandler(async (req, res) => {
  const result = await runCryptoScanner({ preset: req.query.preset });
  broadcast('scanner_run', result);
  res.json(result);
}));

app.get('/api/crypto/scanner/auto-status', (_req, res) => {
  res.json(autoCryptoScannerStatus());
});

app.post('/api/crypto/signals/debug', asyncHandler(async (req, res) => {
  res.json(await debugCryptoSignal(req.body || {}));
}));

app.post('/api/crypto/signals/simulate', asyncHandler(async (req, res) => {
  res.json(await simulateCryptoSignalModes(req.body || {}));
}));

app.get('/api/crypto/near-miss-analytics', asyncHandler(async (_req, res) => {
  res.json(await nearMissAnalytics());
}));

app.post('/api/positions/:symbol/close', asyncHandler(async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const isCrypto = config.primaryMarket === 'crypto' || req.body?.market_type === 'crypto';
  let localOrderId = null;

  if (await hasActiveManualClose(symbol)) {
    return res.status(409).json({ error: `${symbol} already has a manual close request in progress` });
  }
  activeCloseSymbols.add(symbol);

  try {
    emitEvent('Orders', 'manual_close_requested', `${symbol} manual close requested.`, { symbol }, 'warn');
    broadcast('position_close_status', { symbol, status: 'manual_close_requested' });

    const positions = await getPositions();
    const position = positions.find((row) => row.symbol === symbol);
    if (!position) throw new Error(`No open position found for ${symbol}`);

    const qty = Number(position.qty || 0);
    if (qty <= 0) throw new Error(`${symbol} close blocked because SignalFlow will not submit a short-sale close order`);

    await markManualCloseInProgress(symbol);
    localOrderId = nanoid();
    await collections.orders.insertOne({
      id: localOrderId,
      alpaca_order_id: `manual-close-${localOrderId}`,
      signal_id: null,
      market_type: isCrypto ? 'crypto' : 'stocks',
      exchange: isCrypto ? 'coinbase' : 'alpaca',
      symbol,
      side: 'sell',
      notional: Math.abs(Number(position.market_value || 0)),
      status: 'cancelling_open_orders',
      raw_json: JSON.stringify({ reason: 'manual_close', position, lifecycle: 'cancelling_open_orders' }),
      created_at: nowIso(),
      updated_at: nowIso()
    });

    emitEvent('Orders', 'open_order_cancellation_started', `${symbol} open order cancellation started before manual close.`, { symbol, localOrderId }, 'warn');
    broadcast('position_close_status', { symbol, status: 'cancelling_open_orders', localOrderId });
    const liveOrders = isCrypto ? await coinbaseCryptoAdapter.getOpenOrders() : await getOrders();
    const cancellations = isCrypto ? [] : await cancelOpenOrdersForSymbol(symbol, liveOrders);
    const cancellationCheck = isCrypto ? { ok: true } : await waitForOpenOrderCancellations(symbol);
    if (!cancellationCheck.ok) {
      throw new Error(`${symbol} still has open orders after cancellation request`);
    }
    await collections.orders.updateOne(
      { id: localOrderId },
      { $set: { status: 'submitting_close_order', raw_json: JSON.stringify({ reason: 'manual_close', position, cancellations, lifecycle: 'submitting_close_order' }), updated_at: nowIso() } }
    );
    emitEvent('Orders', 'open_orders_cancelled', `${symbol} open orders cancelled.`, { symbol, localOrderId, cancellations });
    emitEvent('Orders', 'submitting_close_order', `${symbol} close order submitting to Alpaca.`, { symbol, localOrderId }, 'warn');
    broadcast('position_close_status', { symbol, status: 'submitting_close_order', localOrderId });

    const order = isCrypto ? await coinbaseCryptoAdapter.closePosition(symbol) : await closePosition(symbol);
    const closeOrder = Array.isArray(order) ? order[0] : order;
    const readable = readableOrder(closeOrder);
    await collections.orders.updateOne(
      { id: localOrderId },
      { $set: { alpaca_order_id: closeOrder?.id || `manual-close-${localOrderId}`, status: 'close_order_submitted', raw_json: JSON.stringify({ reason: 'manual_close', order: readable, raw_order: order, position, cancellations, lifecycle: 'close_order_submitted' }), updated_at: nowIso() } }
    );

    logEvent('warn', 'manual_position_close_submitted', { symbol, qty, localOrderId, alpacaOrderId: closeOrder?.id || null, cancellations, market_type: isCrypto ? 'crypto' : 'stocks' });
    emitEvent('Orders', 'close_order_submitted', `${symbol} close order submitted.`, { symbol, qty, localOrderId, order: readable, cancellations }, 'warn');
    broadcast('position_close_status', { symbol, status: 'close_order_submitted', localOrderId, order: readable });
    broadcast('order_submitted', { symbol, order: readable, reason: 'manual_position_close' });

    const closed = await waitForPositionClosed(symbol, isCrypto);
    if (closed) {
      await collections.orders.updateOne({ id: localOrderId }, { $set: { status: 'close_order_filled', updated_at: nowIso() } });
      await markManualCloseClosed(symbol);
      await recordClosedTrade({ symbol, localOrderId, exitReason: 'manual_close', order: readable, position, protectionMode: getSetting('protection_mode', 'auto') });
      emitEvent('Orders', 'close_order_filled', `${symbol} close order filled.`, { symbol, localOrderId, order: readable });
      emitEvent('Orders', 'position_closed', `${symbol} position closed.`, { symbol, localOrderId, order: readable });
      broadcast('position_close_status', { symbol, status: 'close_order_filled', localOrderId, order: readable });
    }

    res.json({
      ok: true,
      status: closed ? 'close_order_filled' : 'close_order_submitted',
      order: readable,
      cancellations,
      positionClosed: closed
    });
  } catch (error) {
    if (localOrderId) {
      await collections.orders.updateOne(
        { id: localOrderId },
        { $set: { status: 'close_failed', raw_json: JSON.stringify({ reason: 'manual_close', lifecycle: 'close_failed', error: error.message }), updated_at: nowIso() } }
      );
    }
    await markManualCloseFailed(symbol, error.message);
    logEvent('error', 'manual_position_close_failed', { symbol, message: error.message });
    emitEvent('Orders', 'close_order_failed', `${symbol} close order failed: ${error.message}`, { symbol, localOrderId }, 'critical');
    broadcast('position_close_status', { symbol, status: 'close_failed', error: error.message, localOrderId });
    res.status(502).json({ error: error.message });
  } finally {
    activeCloseSymbols.delete(symbol);
  }
}));

app.get('/api/orders', asyncHandler(async (_req, res) => {
  if (config.primaryMarket === 'crypto') {
    const liveOrders = await coinbaseCryptoAdapter.getOpenOrders().catch(() => []);
    const localOrders = withoutMongoIds(await collections.orders.find({ market_type: 'crypto' }).sort({ created_at: -1 }).limit(200).toArray());
    res.json({ liveOrders, localOrders });
    return;
  }
  const liveOrders = await getOrders();
  await syncLocalOrderStatuses(liveOrders);
  const localOrders = withoutMongoIds(await collections.orders.find({}).sort({ created_at: -1 }).limit(200).toArray());
  res.json({ liveOrders, localOrders });
}));

app.get('/api/watchlist', asyncHandler(async (_req, res) => {
  const watchlist = await scanWatchlist();
  broadcast('watchlist', watchlist);
  res.json(watchlist);
}));

app.get('/api/watchlists', asyncHandler(async (_req, res) => {
  res.json({
    context: [],
    tradingUniverse: await latestTradingUniverse(),
    blocked: await blockedSymbols()
  });
}));

app.get('/api/watchlists/context', asyncHandler(async (_req, res) => {
  const rows = await scanContextWatchlist();
  broadcast('context_watchlist', rows);
  res.json(rows);
}));

app.get('/api/watchlists/trading-universe', asyncHandler(async (_req, res) => {
  res.json(await latestTradingUniverse());
}));

app.get('/api/scanner/settings', (_req, res) => {
  res.json(scannerSettingsPayload());
});

app.post('/api/scanner/settings', (req, res) => {
  const settings = req.body?.relax === true
    ? relaxScannerSettings()
    : saveScannerSettings(req.body || {});
  emitEvent('Scanner', 'scanner_settings_updated', 'Scanner settings updated.', { settings });
  res.json(scannerSettingsPayload());
});

app.post('/api/scanner/run', asyncHandler(async (req, res) => {
  emitEvent('Scanner', 'scanner_started', 'Scanner started.', {});
  const result = await runTradingUniverseScanner({ preset: req.query.preset });
  emitEvent('Scanner', 'scanner_completed', `Scanner completed: ${result.passed.length} passed, ${result.rejected.length} rejected.`, { runId: result.runId, passed: result.passed.length, rejected: result.rejected.length });
  broadcast('scanner_run', result);
  res.json(result);
}));

app.get('/api/scanner/runs', asyncHandler(async (_req, res) => {
  res.json(await scannerRuns());
}));

app.get('/api/scanner/runs/:id', asyncHandler(async (req, res) => {
  const result = await scannerRun(req.params.id);
  if (!result.run) return res.status(404).json({ error: 'Scanner run not found' });
  res.json(result);
}));

app.post('/api/watchlists/:symbol/add', asyncHandler(async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const group = req.body?.group || 'user_added';
  await collections.watchlistGroups.updateOne(
    { symbol, group_name: group },
    { $set: { symbol, group_name: group, enabled: 1 }, $setOnInsert: { created_at: nowIso() } },
    { upsert: true }
  );
  logEvent('info', 'watchlist_symbol_added', { symbol, group });
  res.json({ ok: true, symbol, group });
}));

app.delete('/api/watchlists/:symbol', asyncHandler(async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  await collections.watchlistGroups.updateMany({ symbol, group_name: { $in: ['trading_universe', 'user_added'] } }, { $set: { enabled: 0 } });
  logEvent('info', 'watchlist_symbol_removed', { symbol });
  res.json({ ok: true, symbol });
}));

app.post('/api/watchlists/:symbol/block', asyncHandler(async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  await collections.watchlistGroups.updateOne(
    { symbol, group_name: 'blocked' },
    { $set: { symbol, group_name: 'blocked', enabled: 1 }, $setOnInsert: { created_at: nowIso() } },
    { upsert: true }
  );
  logEvent('warn', 'watchlist_symbol_blocked', { symbol });
  res.json({ ok: true, symbol });
}));

app.post('/api/watchlists/:symbol/unblock', asyncHandler(async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  await collections.watchlistGroups.updateOne({ symbol, group_name: 'blocked' }, { $set: { enabled: 0 } });
  logEvent('info', 'watchlist_symbol_unblocked', { symbol });
  res.json({ ok: true, symbol });
}));

app.get('/api/market-regime', asyncHandler(async (_req, res) => {
  res.json(await getMarketRegime());
}));

app.get('/api/signals', asyncHandler(async (_req, res) => {
  const pending = await collections.signals.find({ status: 'pending' }).toArray();
  await Promise.all(pending.map((signal) => collections.signals.updateOne(
    { id: signal.id },
    {
      $set: {
        expires_at: signal.expires_at || new Date(new Date(signal.created_at || nowIso()).getTime() + config.signalTtlSeconds * 1000).toISOString(),
        signal_price: signal.signal_price ?? signal.entry_price,
        stale_status: signal.stale_status || 'fresh'
      }
    }
  )));
  const rows = withoutMongoIds(await collections.signals.find({}).sort({ created_at: -1 }).limit(100).toArray());
  res.json(rows);
}));

app.get('/api/signals/:id/review', asyncHandler(async (req, res) => {
  const signal = withoutMongoId(await collections.signals.findOne({ id: req.params.id }));
  if (!signal) return res.status(404).json({ error: 'Signal not found' });

  if (signal.market_type === 'crypto') {
    const [ticker, candles, risk] = await Promise.all([
      coinbaseCryptoAdapter.getTicker(signal.symbol),
      coinbaseCryptoAdapter.getCandles(signal.symbol, '5m'),
      evaluateCryptoRisk(signal)
    ]);
    const currentPrice = Number(ticker.price || signal.entry_price || 0);
    const signalPrice = Number(signal.signal_price || signal.entry_price || 0);
    const extensionPercent = Math.abs(pctMove(signalPrice, currentPrice));
    const remaining = secondsRemaining(signal);
    const noChaseStatus = remaining <= 0 || extensionPercent > config.maxExtensionFromSignalPercent
      ? 'BLOCKED: CHASE RISK'
      : extensionPercent > config.maxExtensionFromSignalPercent * 0.5
        ? 'WARNING: MOVING'
        : 'SAFE TO REVIEW';
    const closes = candles.map((row) => row.close);
    const latestVolume = Number(candles.at(-1)?.volume || 0);
    const avgVolume = candles.slice(-30).reduce((sum, row) => sum + Number(row.volume || 0), 0) / Math.max(1, Math.min(30, candles.length));
    const qty = Number(risk.qty || (risk.notional ? risk.notional / Number(signal.entry_price) : 0));
    const plannedRiskDollars = Math.abs(Number(signal.entry_price) - Number(signal.stop_loss)) * qty;
    const plannedRewardDollars = Math.abs(Number(signal.take_profit) - Number(signal.entry_price)) * qty;
    const regime = await cryptoMarketRegime().catch(() => ({ regime: 'NEUTRAL' }));
    const blocked = Boolean(await collections.watchlistGroups.findOne({ symbol: signal.symbol, group_name: { $in: ['crypto_blocked', 'blocked'] }, enabled: 1 }));
    await collections.signals.updateOne(
      { id: signal.id },
      { $set: { last_reviewed_at: nowIso(), review_price: currentPrice, stale_status: noChaseStatus.startsWith('BLOCKED') ? 'blocked_chase_risk' : noChaseStatus.startsWith('WARNING') ? 'moving' : 'reviewed_fresh' } }
    );
    res.json({
      signal,
      expiresAt: signal.expires_at,
      secondsRemaining: remaining,
      latest: { currentPrice, spreadPercent: ticker.spreadPercent, relativeVolume: avgVolume ? latestVolume / avgVolume : 0, indicators: { candles: closes.length } },
      sizing: {
        plannedRiskDollars,
        plannedRewardDollars,
        plannedRr: plannedRiskDollars ? plannedRewardDollars / plannedRiskDollars : 0,
        positionNotional: risk.notional || 0,
        quantity: qty,
        fractionalQuantity: true
      },
      riskCheckPreview: risk,
      protectionMode: risk.protectionMode || 'blocked',
      marketRegime: regime.regime || 'NEUTRAL',
      scannerPreset: getSetting('active_crypto_scanner_preset', 'crypto_micro_account'),
      confidenceScore: Number(signal.confidence || 0),
      noChase: {
        status: noChaseStatus,
        signalPrice,
        reviewPrice: currentPrice,
        currentPrice,
        slippagePercent: 0,
        extensionPercent,
        maxEntrySlippagePercent: config.maxEntrySlippagePercent,
        maxExtensionFromSignalPercent: config.maxExtensionFromSignalPercent
      },
      checklist: {
        priceAboveVwap: true,
        ema9AboveEma20: true,
        breakoutAboveRecentHigh: true,
        volumeAboveAverage: avgVolume ? latestVolume > avgVolume : false,
        spreadAcceptable: Number(ticker.spreadPercent || 0) <= config.cryptoMaxSpreadPercent,
        marketRegimeAllowsLong: ['BULLISH', 'NEUTRAL'].includes(regime.regime),
        symbolTradable: true,
        symbolNotBlocked: !blocked
      },
      warnings: [
        ...(Number(ticker.spreadPercent || 0) > config.cryptoMaxSpreadPercent ? ['Spread is wider than crypto max spread setting.'] : []),
        ...(remaining <= 0 ? ['Signal TTL has expired.'] : []),
        ...(extensionPercent > config.maxExtensionFromSignalPercent * 0.5 ? ['Price is moving away from the original signal price.'] : []),
        'Crypto exits use SignalFlow Monitor; backend must stay online.',
        'Crypto is 24/7 and can move quickly through stops during volatility.'
      ],
      rejectReasons: risk.ok ? [] : [risk.reason]
    });
    return;
  }

  const [market, asset, risk] = await Promise.all([
    safeMarketRow(signal.symbol),
    getAsset(signal.symbol).catch(() => null),
    evaluateRisk(signal, { preview: true })
  ]);
  const settings = scannerSettings();
  const regime = await latestMarketRegime();
  const blocked = Boolean(await collections.watchlistGroups.findOne({ symbol: signal.symbol, group_name: 'blocked', enabled: 1 }));
  const bars = market.bars || [];
  const recentHigh = bars.length > 2 ? Math.max(...bars.slice(-6, -1).map((bar) => Number(bar.high || 0))) : 0;
  const currentPrice = Number(market.price || signal.entry_price || 0);
  const entry = Number(signal.entry_price || 0);
  const stop = Number(signal.stop_loss || 0);
  const target = Number(signal.take_profit || 0);
  const qty = Number(risk.qty || (risk.sizing?.finalNotional ? risk.sizing.finalNotional / entry : 0));
  const positionNotional = Number(risk.notional || risk.sizing?.finalNotional || 0);
  const plannedRiskDollars = Math.abs(entry - stop) * qty;
  const plannedRewardDollars = Math.abs(target - entry) * qty;
  const rr = plannedRiskDollars ? plannedRewardDollars / plannedRiskDollars : 0;
  const spread = Number(market.spread_percent || 0);
  const relativeVolume = Number(market.volume || 0) / Math.max(1, Number(market.indicators?.volume_avg || 0));
  const signalPrice = Number(signal.signal_price || signal.entry_price || 0);
  const extensionPercent = Math.abs(pctMove(signalPrice, currentPrice));
  const reviewPrice = currentPrice;
  const slippagePercent = Math.abs(pctMove(reviewPrice, currentPrice));
  const remaining = secondsRemaining(signal);
  const noChaseStatus = remaining <= 0 || extensionPercent > config.maxExtensionFromSignalPercent
    ? 'BLOCKED: CHASE RISK'
    : extensionPercent > config.maxExtensionFromSignalPercent * 0.5
      ? 'WARNING: MOVING'
      : 'SAFE TO REVIEW';

  const checklist = {
    priceAboveVwap: currentPrice > Number(market.indicators?.vwap || 0),
    ema9AboveEma20: Number(market.indicators?.ema9 || 0) > Number(market.indicators?.ema20 || 0),
    breakoutAboveRecentHigh: recentHigh ? currentPrice > recentHigh : false,
    volumeAboveAverage: Number(market.volume || 0) > Number(market.indicators?.volume_avg || 0),
    spreadAcceptable: spread <= settings.maxSpreadPercent,
    marketRegimeAllowsLong: signal.direction !== 'BUY' || ['BULLISH', 'NEUTRAL'].includes(regime.regime),
    symbolTradable: Boolean(asset?.tradable),
    symbolNotBlocked: !blocked
  };

  const warnings = [];
  if (!checklist.spreadAcceptable) warnings.push('Spread is wider than the scanner setting.');
  if (!checklist.volumeAboveAverage) warnings.push('Volume is below recent average.');
  if (!checklist.marketRegimeAllowsLong) warnings.push('Market regime does not currently favor long entries.');
  if (relativeVolume < settings.minRelativeVolume) warnings.push('Relative volume is below the active scanner filter.');
  if (Math.abs(Number(market.change_percent || 0)) < settings.minPercentChange) warnings.push('Percent change is below the active scanner filter.');
  if (risk.protectionMode === 'monitored_fractional') warnings.push('Monitored exit depends on the backend staying online.');
  if (remaining <= 0) warnings.push('Signal TTL has expired.');
  if (extensionPercent > config.maxExtensionFromSignalPercent * 0.5) warnings.push('Price is moving away from the original signal price.');
  if (market.data_error) warnings.push(`Scanner data issue: ${market.data_error}`);
  ['spread widened', 'low volume', 'market regime changed', 'price extended too far', 'stop too tight', 'scanner data stale', 'monitored exit depends on backend staying online'].forEach((item) => {
    if (!warnings.includes(item)) warnings.push(item);
  });

  await collections.signals.updateOne(
    { id: signal.id },
    { $set: { last_reviewed_at: nowIso(), review_price, stale_status: noChaseStatus.startsWith('BLOCKED') ? 'blocked_chase_risk' : noChaseStatus.startsWith('WARNING') ? 'moving' : 'reviewed_fresh' } }
  );

  res.json({
    signal,
    expiresAt: signal.expires_at,
    secondsRemaining: remaining,
    latest: {
      currentPrice,
      spreadPercent: spread,
      relativeVolume,
      recentHigh,
      quoteSource: market.data_source,
      indicators: market.indicators
    },
    sizing: {
      plannedRiskDollars,
      plannedRewardDollars,
      plannedRr: rr,
      positionNotional,
      quantity: qty,
      fractionalQuantity: qty > 0 && qty < 1
    },
    riskCheckPreview: risk,
    protectionMode: risk.protectionMode || 'blocked',
    marketRegime: regime.regime || 'NEUTRAL',
    scannerPreset: getSetting('active_scanner_preset', 'manual'),
    confidenceScore: Number(signal.confidence || 0),
    noChase: {
      status: noChaseStatus,
      signalPrice,
      reviewPrice,
      currentPrice,
      slippagePercent,
      extensionPercent,
      maxEntrySlippagePercent: config.maxEntrySlippagePercent,
      maxExtensionFromSignalPercent: config.maxExtensionFromSignalPercent
    },
    checklist,
    warnings,
    rejectReasons: risk.ok ? [] : [risk.reason]
  });
}));

app.post('/api/signals/:id/reject', asyncHandler(async (req, res) => {
  const signal = withoutMongoId(await collections.signals.findOne({ id: req.params.id }));
  if (!signal) return res.status(404).json({ error: 'Signal not found' });
  const at = nowIso();
  await collections.signals.updateOne({ id: req.params.id }, { $set: { status: 'rejected', resolved_at: at, expired_at: at, expiration_reason: 'manually_rejected', stale_status: 'manually_rejected' } });
  logEvent('info', 'signal_rejected', { signalId: req.params.id, reason: req.body?.reason || 'manual_reject' });
  broadcast('signal_rejected', { id: req.params.id });
  res.json({ ok: true });
}));

app.post('/api/signals/:id/approve', asyncHandler(async (req, res) => {
  const signal = withoutMongoId(await collections.signals.findOne({ id: req.params.id }));
  if (!signal) return res.status(404).json({ error: 'Signal not found' });
  if (signal.status !== 'pending') {
    const reason = signal.expiration_reason || `Signal is not pending (${signal.status})`;
    emitEvent('Risk', 'approval_blocked_stale', `${signal.symbol} approval blocked: ${reason}`, { signalId: signal.id, symbol: signal.symbol, reason }, 'warn');
    return res.status(409).json({ error: reason, reason });
  }

  const approvalValidation = await validateSignalBeforeApproval(signal);
  if (!approvalValidation.ok) {
    emitEvent('Risk', 'approval_blocked_stale', `${signal.symbol} approval blocked: ${approvalValidation.reason}`, { signalId: signal.id, symbol: signal.symbol, reason: approvalValidation.reason }, 'warn');
    return res.status(approvalValidation.status || 409).json({ ok: false, reason: approvalValidation.reason, ...approvalValidation });
  }

  const finalRisk = signal.market_type === 'crypto' ? await evaluateCryptoRisk(signal) : await evaluateRisk(signal);
  if (!finalRisk.ok) {
    await collections.signals.updateOne({ id: signal.id }, { $set: { status: 'risk_rejected', resolved_at: nowIso() } });
    emitEvent('Risk', 'signal_blocked', `${signal.symbol} blocked: ${finalRisk.reason}`, { signalId: signal.id, reason: finalRisk.reason }, 'warn');
    return res.status(422).json(finalRisk);
  }

  try {
    const side = signal.direction === 'SELL' ? 'sell' : 'buy';
    const order = signal.market_type === 'crypto'
      ? await coinbaseCryptoAdapter.submitOrder({ symbol: signal.symbol, side, notional: finalRisk.notional, qty: finalRisk.qty })
      : finalRisk.exitPosition
        ? await submitMarketExitOrder({ symbol: signal.symbol, qty: finalRisk.exitPosition.qty })
        : finalRisk.protectionMode === 'monitored_fractional'
          ? await submitSimpleNotionalBuyOrder({ symbol: signal.symbol, notional: finalRisk.notional })
        : await submitBracketNotionalOrder({
          symbol: signal.symbol,
          side,
          qty: finalRisk.qty,
          stopLoss: signal.stop_loss,
          takeProfit: signal.take_profit
        });

    const localOrderId = nanoid();
    await collections.orders.insertOne({
      id: localOrderId,
      alpaca_order_id: order.id || order.order_id || order.success_response?.order_id || nanoid(),
      signal_id: signal.id,
      market_type: signal.market_type || 'stocks',
      exchange: signal.exchange || 'alpaca',
      adapter_name: signal.adapter_name || signal.exchange || 'alpaca',
      base_asset: signal.base_asset || signal.symbol.split('-')[0],
      quote_asset: signal.quote_asset || 'USD',
      product_id: signal.product_id || signal.symbol,
      symbol: signal.symbol,
      side,
      notional: finalRisk.notional,
      status: order.status || 'submitted',
      raw_json: JSON.stringify(order),
      created_at: nowIso(),
      updated_at: nowIso()
    });
    let monitoredId = null;
    if (finalRisk.protectionMode === 'monitored_fractional' || finalRisk.protectionMode === 'signalflow_monitor') {
      monitoredId = await createMonitoredPosition({ symbol: signal.symbol, order: { ...order, id: order.id || order.order_id || order.success_response?.order_id || localOrderId }, signal, notional: finalRisk.notional, qty: finalRisk.qty, marketType: signal.market_type || 'stocks', exchange: signal.exchange || 'alpaca', adapterName: signal.adapter_name || signal.exchange || 'alpaca' });
    }
    await collections.signals.updateOne({ id: signal.id }, { $set: { status: 'approved', resolved_at: nowIso() } });
    emitEvent('Orders', 'order_submitted', `${signal.symbol} order submitted with ${finalRisk.protectionMode} protection.`, { signalId: signal.id, orderId: order.id || order.order_id || order.success_response?.order_id, symbol: signal.symbol, notional: finalRisk.notional, protectionMode: finalRisk.protectionMode, monitoredId, market_type: signal.market_type || 'stocks' });
    broadcast('order_submitted', { signalId: signal.id, order, protectionMode: finalRisk.protectionMode, monitoredId });
    res.json({ ok: true, order, protectionMode: finalRisk.protectionMode, monitoredId });
  } catch (error) {
    logEvent('error', 'order_submission_failed', { signalId: signal.id, message: error.message });
    emitEvent('Orders', 'order_submission_failed', `${signal.symbol} order submission failed: ${error.message}`, { signalId: signal.id }, 'critical');
    res.status(500).json({ error: error.message });
  }
}));

app.post('/api/trading/kill-switch', (req, res) => {
  const enabled = req.body?.enabled !== false;
  setSetting('kill_switch', String(enabled));
  logEvent('warn', enabled ? 'kill_switch_enabled' : 'kill_switch_disabled', {});
  emitEvent('Risk', enabled ? 'kill_switch_activated' : 'kill_switch_reset', enabled ? 'Kill switch activated.' : 'Kill switch reset.', {}, enabled ? 'critical' : 'info');
  broadcast('kill_switch', { enabled });
  res.json({ ok: true, enabled });
});

app.post('/api/settings', (req, res) => {
  const previousAutoScanner = autoCryptoScannerConfig();
  Object.entries(req.body || {}).forEach(([key, value]) => {
    if (key === 'auto_execution' && String(value) === 'true' && !config.autoExecution) {
      return;
    }
    setSetting(key, value);
  });
  const nextAutoScanner = autoCryptoScannerConfig();
  if (
    previousAutoScanner.enabled !== nextAutoScanner.enabled
    || previousAutoScanner.intervalMs !== nextAutoScanner.intervalMs
  ) {
    restartAutoCryptoScanner();
  }
  logEvent('info', 'settings_updated', req.body || {});
  res.json(allSettings());
});

app.get('/api/performance', asyncHandler(async (_req, res) => {
  const trades = withoutMongoIds(await collections.trades.find({}).sort({ created_at: -1 }).limit(200).toArray());
  const logs = withoutMongoIds(await collections.systemLogs.find({}).sort({ created_at: -1 }).limit(100).toArray());
  const pnl = trades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  res.json({ pnl, tradeCount: trades.length, trades, logs, killSwitch: getSetting('kill_switch', 'false') === 'true' });
}));

app.get('/api/journal', asyncHandler(async (_req, res) => {
  res.json({ rows: await journalRows(), mistakeTags });
}));

app.post('/api/journal/:id/notes', asyncHandler(async (req, res) => {
  res.json(await updateJournalNotes(req.params.id, req.body || {}));
}));

app.get('/api/performance/summary', asyncHandler(async (_req, res) => {
  res.json(await performanceSummary());
}));

app.get('/api/performance/daily', asyncHandler(async (_req, res) => {
  res.json(await performanceDaily());
}));

app.get('/api/performance/strategy', asyncHandler(async (_req, res) => {
  res.json(await performanceStrategy());
}));

app.get('/api/performance/symbols', asyncHandler(async (_req, res) => {
  res.json(await performanceSymbols());
}));

app.get('/api/signals/outcomes', asyncHandler(async (_req, res) => {
  res.json(await signalOutcomes());
}));

app.get('/api/events', asyncHandler(async (req, res) => {
  res.json(await recentEvents(Number(req.query.limit || 100)));
}));

app.get('/api/monitored-positions', asyncHandler(async (_req, res) => {
  res.json(await monitoredPositions());
}));

app.get('/api/monitored-positions/:id', asyncHandler(async (req, res) => {
  const row = await monitoredPosition(req.params.id);
  if (!row) return res.status(404).json({ error: 'Monitored position not found' });
  res.json(row);
}));

app.post('/api/monitored-positions/:id/exit', asyncHandler(async (req, res) => {
  res.json(await manualExit(req.params.id));
}));

app.post('/api/monitored-positions/:id/mark-reviewed', asyncHandler(async (req, res) => {
  res.json(await markReviewed(req.params.id));
}));

app.get('/api/monitor/status', asyncHandler(async (_req, res) => {
  res.json(await monitorStatus());
}));

app.get('/api/market-clock', asyncHandler(async (_req, res) => {
  const clock = await getMarketClock();
  res.json(clock);
}));

app.get('/health', (_req, res) => res.json({ ok: true, mode: executionMode() }));

app.use((error, _req, res, _next) => {
  logEvent('error', 'api_error', { message: error.message });
  res.status(502).json({ error: error.message });
});

const server = http.createServer(app);
attachWebSocket(server);

server.listen(config.port, () => {
  logEvent('info', 'server_started', { port: config.port, mode: executionMode() });
  emitEvent('System', 'server_started', `SignalFlow backend listening on ${config.port}.`, { port: config.port, mode: executionMode() });
  startMonitor();
  startSignalExpirationJob();
  startAutoCryptoScanner();
  console.log(`SignalFlow backend listening on ${config.port}`);
});
