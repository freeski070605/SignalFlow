import { MongoClient } from 'mongodb';
import { nanoid } from 'nanoid';
import { config } from './config.js';

if (!config.mongodbUri) {
  throw new Error('MONGODB_URI is required. SignalFlow is configured for MongoDB-only persistence.');
}

export const mongoClient = new MongoClient(config.mongodbUri, { serverSelectionTimeoutMS: 10000 });
await mongoClient.connect();

export const mongo = mongoClient.db(config.mongodbDatabase);

export const collections = {
  users: mongo.collection('users'),
  settings: mongo.collection('settings'),
  watchlist: mongo.collection('watchlist'),
  watchlistGroups: mongo.collection('watchlist_groups'),
  tradingUniverseCandidates: mongo.collection('trading_universe_candidates'),
  scannerRuns: mongo.collection('scanner_runs'),
  scannerRejections: mongo.collection('scanner_rejections'),
  candidateHistory: mongo.collection('candidate_history'),
  marketRegime: mongo.collection('market_regime'),
  monitoredPositions: mongo.collection('monitored_positions'),
  systemEvents: mongo.collection('system_events'),
  signals: mongo.collection('signals'),
  orders: mongo.collection('orders'),
  positions: mongo.collection('positions'),
  trades: mongo.collection('trades'),
  tradeJournal: mongo.collection('trade_journal'),
  performanceDaily: mongo.collection('performance_daily'),
  strategyStats: mongo.collection('strategy_stats'),
  signalOutcomes: mongo.collection('signal_outcomes'),
  riskEvents: mongo.collection('risk_events'),
  systemLogs: mongo.collection('system_logs')
};

const settingsCache = new Map();

export const nowIso = () => new Date().toISOString();

export function withoutMongoId(row) {
  if (!row) return row;
  const { _id, ...rest } = row;
  return rest;
}

export function withoutMongoIds(rows = []) {
  return rows.map(withoutMongoId);
}

async function seedWatchlistGroup(symbol, groupName) {
  await collections.watchlistGroups.updateOne(
    { symbol, group_name: groupName },
    { $setOnInsert: { symbol, group_name: groupName, enabled: 1, created_at: nowIso() } },
    { upsert: true }
  );
}

const defaultSettings = {
  strategy_enabled: 'true',
  risk_amount: String(config.maxTradeRisk),
  position_size_cap: String(config.maxPositionNotional),
  stop_loss_percent: '1',
  take_profit_percent: '2',
  trading_window: '09:30-15:55',
  auto_execution: String(config.autoExecution),
  kill_switch: 'false',
  enable_context_symbol_trading: String(config.enableContextSymbolTrading),
  risk_per_trade_percent: String(config.riskPerTradePercent),
  max_account_position_percent: String(config.maxAccountPositionPercent),
  max_daily_loss_percent: String(config.maxDailyLossPercent),
  min_notional_order: String(config.minNotionalOrder),
  allow_fractional_entries: String(config.allowFractionalEntries),
  protection_mode: config.protectionMode,
  monitored_exit_interval_ms: String(config.monitoredExitIntervalMs),
  monitored_exit_max_stale_seconds: String(config.monitoredExitMaxStaleSeconds),
  allow_monitored_fractional_exits: String(config.allowMonitoredFractionalExits),
  min_price: String(config.scanner.minPrice),
  max_price: String(config.scanner.maxPrice),
  min_daily_volume: String(config.scanner.minDailyVolume),
  min_relative_volume: String(config.scanner.minRelativeVolume),
  max_spread_percent: String(config.scanner.maxSpreadPercent),
  min_percent_change: String(config.scanner.minPercentChange),
  exclude_otc: String(config.scanner.excludeOtc),
  require_active: String(config.scanner.requireActive),
  require_tradable: String(config.scanner.requireTradable),
  prefer_fractionable: String(config.scanner.preferFractionable),
  exclude_leveraged_etfs: String(config.scanner.excludeLeveragedEtfs),
  max_results: String(config.scanner.maxResults),
  primary_market: config.primaryMarket,
  active_exchange: config.activeExchange,
  min_crypto_price: String(config.cryptoScanner.minPrice),
  max_crypto_price: String(config.cryptoScanner.maxPrice),
  min_24h_volume_usd: String(config.cryptoScanner.min24hVolumeUsd),
  crypto_min_relative_volume: String(config.cryptoScanner.minRelativeVolume),
  min_percent_change_15m: String(config.cryptoScanner.minPercentChange15m),
  min_percent_change_1h: String(config.cryptoScanner.minPercentChange1h),
  crypto_max_spread_percent: String(config.cryptoScanner.maxSpreadPercent),
  min_candle_count: String(config.cryptoScanner.minCandleCount),
  exclude_stablecoins: String(config.cryptoScanner.excludeStablecoins),
  crypto_max_results: String(config.cryptoScanner.maxResults),
  crypto_risk_per_trade_percent: String(config.cryptoRiskPerTradePercent),
  crypto_max_account_position_percent: String(config.cryptoMaxAccountPositionPercent),
  crypto_max_daily_loss_percent: String(config.cryptoMaxDailyLossPercent),
  crypto_max_open_positions: String(config.cryptoMaxOpenPositions),
  crypto_min_notional_order: String(config.cryptoMinNotionalOrder),
  crypto_stop_loss_percent: String(config.cryptoStopLossPercent),
  crypto_take_profit_percent: String(config.cryptoTakeProfitPercent),
  crypto_max_slippage_percent: String(config.cryptoMaxSlippagePercent),
  crypto_daily_trade_limit: String(config.cryptoDailyTradeLimit),
  auto_crypto_scanner: String(config.autoCryptoScanner),
  crypto_scanner_interval_ms: String(config.cryptoScannerIntervalMs),
  allow_counter_regime_trades: String(config.allowCounterRegimeTrades),
  require_price_above_vwap: 'true',
  require_ema9_above_ema20: 'true',
  require_positive_15m_momentum: 'true',
  rsi_min: '45',
  rsi_max: '75',
  max_signal_spread_percent: '0.35',
  min_signal_score: '60',
  signal_mode: 'strict',
  enable_legacy_crypto_strategy: String(config.enableLegacyCryptoStrategy),
  block_longs_in_bearish_regime: String(config.blockLongsInBearishRegime),
  allow_neutral_longs: String(config.allowNeutralLongs),
  min_v2_signal_quality: String(config.minV2SignalQuality),
  min_v2_risk_reward: String(config.minV2RiskReward),
  max_distance_from_vwap_percent: String(config.maxDistanceFromVwapPercent),
  max_distance_from_ema20_percent: String(config.maxDistanceFromEma20Percent),
  min_pullback_depth_percent: String(config.minPullbackDepthPercent),
  max_pullback_depth_percent: String(config.maxPullbackDepthPercent),
  min_reclaim_strength_percent: String(config.minReclaimStrengthPercent),
  min_v2_relative_volume: String(config.cryptoScanner.minRelativeVolume),
  min_15m_momentum: String(config.min15mMomentum),
  min_1h_momentum: String(config.min1hMomentum)
};

async function createIndexes() {
  await Promise.all([
    collections.settings.createIndex({ key: 1 }, { unique: true }),
    collections.watchlist.createIndex({ symbol: 1 }, { unique: true }),
    collections.watchlistGroups.createIndex({ symbol: 1, group_name: 1 }, { unique: true }),
    collections.tradingUniverseCandidates.createIndex({ run_id: 1, passed: 1, score: -1 }),
    collections.tradingUniverseCandidates.createIndex({ market_type: 1, symbol: 1 }),
    collections.scannerRuns.createIndex({ status: 1, created_at: -1 }),
    collections.scannerRejections.createIndex({ run_id: 1, scanned_at: -1 }),
    collections.candidateHistory.createIndex({ run_id: 1, symbol: 1 }),
    collections.candidateHistory.createIndex({ created_at: -1 }),
    collections.marketRegime.createIndex({ created_at: -1 }),
    collections.monitoredPositions.createIndex({ id: 1 }, { unique: true }),
    collections.monitoredPositions.createIndex({ symbol: 1, status: 1, opened_at: -1 }),
    collections.systemEvents.createIndex({ event: 1, created_at: -1 }),
    collections.systemEvents.createIndex({ created_at: -1 }),
    collections.signals.createIndex({ id: 1 }, { unique: true }),
    collections.signals.createIndex({ symbol: 1, status: 1, market_type: 1, created_at: -1 }),
    collections.signals.createIndex({ status: 1, created_at: 1 }),
    collections.orders.createIndex({ id: 1 }, { unique: true }),
    collections.orders.createIndex({ symbol: 1, side: 1, created_at: -1 }),
    collections.orders.createIndex({ status: 1, created_at: -1 }),
    collections.tradeJournal.createIndex({ id: 1 }, { unique: true }),
    collections.tradeJournal.createIndex({ trade_id: 1 }, { unique: true }),
    collections.signalOutcomes.createIndex({ signal_id: 1 }, { unique: true }),
    collections.performanceDaily.createIndex({ day: 1 }, { unique: true }),
    collections.strategyStats.createIndex({ strategy_name: 1 }, { unique: true }),
    collections.systemLogs.createIndex({ created_at: -1 })
  ]);
}

async function seedDefaults() {
  const defaults = ['SPY', 'QQQ', 'IWM', 'DIA', 'NVDA', 'AMD', 'AAPL', 'MSFT'];
  await Promise.all(defaults.map((symbol) => collections.watchlist.updateOne(
    { symbol },
    { $setOnInsert: { symbol, enabled: 1, created_at: nowIso() } },
    { upsert: true }
  )));

  await Promise.all([
    ...defaults.map((symbol) => seedWatchlistGroup(symbol, 'market_context')),
    ...defaults.map((symbol) => seedWatchlistGroup(symbol, 'stock_market_context')),
    ...['SOFI', 'PLTR', 'RIVN', 'LCID', 'F', 'PFE', 'NIO', 'HOOD', 'SNAP', 'INTC', 'AMD', 'TSLA', 'AAPL', 'MSFT', 'NVDA', 'MARA', 'RIOT', 'BAC', 'T', 'WBD']
      .flatMap((symbol) => [seedWatchlistGroup(symbol, 'trading_universe'), seedWatchlistGroup(symbol, 'stock_trading_universe')]),
    ...['BTC-USD', 'ETH-USD', 'SOL-USD'].map((symbol) => seedWatchlistGroup(symbol, 'crypto_major')),
    ...['LINK-USD', 'AVAX-USD', 'ADA-USD', 'DOGE-USD', 'XRP-USD', 'LTC-USD', 'BCH-USD'].map((symbol) => seedWatchlistGroup(symbol, 'crypto_alt'))
  ]);

  await Promise.all(Object.entries(defaultSettings).map(([key, value]) => collections.settings.updateOne(
    { key },
    { $setOnInsert: { key, value: String(value), updated_at: nowIso() } },
    { upsert: true }
  )));
}

async function loadSettingsCache() {
  settingsCache.clear();
  const rows = await collections.settings.find({}).toArray();
  rows.forEach((row) => settingsCache.set(row.key, row.value));
}

export async function migrate() {
  await createIndexes();
  await seedDefaults();
  await loadSettingsCache();
}

export function logEvent(level, event, payload = {}) {
  collections.systemLogs.insertOne({
    id: nanoid(),
    level,
    event,
    payload: JSON.stringify(payload),
    created_at: nowIso()
  }).catch((error) => console.error(`system log write failed: ${error.message}`));
}

export function getSetting(key, fallback = null) {
  return settingsCache.has(key) ? settingsCache.get(key) : fallback;
}

export function setSetting(key, value) {
  const next = String(value);
  settingsCache.set(key, next);
  collections.settings.updateOne(
    { key },
    { $set: { key, value: next, updated_at: nowIso() } },
    { upsert: true }
  ).catch((error) => console.error(`setting write failed for ${key}: ${error.message}`));
}

export function allSettings() {
  return Object.fromEntries(settingsCache.entries());
}

export async function closeDatabase() {
  await mongoClient.close();
}

async function shutdown() {
  await closeDatabase().catch(() => null);
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
