import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nanoid } from 'nanoid';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const db = new DatabaseSync(config.databasePath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const isLocked = (error) => (
  error?.code === 'ERR_SQLITE_ERROR'
  && (error?.errcode === 5 || String(error?.message || '').includes('database is locked'))
);

function withRetry(operation, attempts = 8) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (!isLocked(error) || attempt === attempts) break;
      sleep(150 * attempt);
    }
  }
  throw lastError;
}

function closeDatabase() {
  try {
    db.close();
  } catch {
    // The process is already exiting; avoid masking the original shutdown signal.
  }
}

process.once('SIGINT', () => {
  closeDatabase();
  process.exit(0);
});

process.once('SIGTERM', () => {
  closeDatabase();
  process.exit(0);
});

export function migrate() {
  withRetry(() => db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      symbol TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS watchlist_groups (
      symbol TEXT NOT NULL,
      group_name TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (symbol, group_name)
    );

    CREATE TABLE IF NOT EXISTS trading_universe_candidates (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      market_type TEXT,
      exchange TEXT,
      adapter_name TEXT,
      product_id TEXT,
      symbol TEXT NOT NULL,
      name TEXT,
      price REAL,
      percent_change REAL,
      volume REAL,
      average_volume REAL,
      relative_volume REAL,
      spread_percent REAL,
      tradable INTEGER,
      fractionable INTEGER,
      asset_status TEXT,
      score REAL,
      passed INTEGER,
      reason TEXT,
      signal_status TEXT,
      scanned_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS scanner_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      market_type TEXT,
      exchange TEXT,
      adapter_name TEXT,
      total_scanned INTEGER DEFAULT 0,
      passed_count INTEGER DEFAULT 0,
      rejected_count INTEGER DEFAULT 0,
      settings_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS scanner_rejections (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      symbol TEXT NOT NULL,
      reason TEXT NOT NULL,
      scanned_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS candidate_history (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      market_type TEXT,
      exchange TEXT,
      adapter_name TEXT,
      product_id TEXT,
      symbol TEXT NOT NULL,
      price REAL,
      score REAL,
      volume REAL,
      relative_volume REAL,
      momentum_15m REAL,
      momentum_1h REAL,
      spread_percent REAL,
      probability TEXT,
      needs_json TEXT,
      signal_status TEXT,
      signal_generation_status TEXT,
      was_near_miss INTEGER DEFAULT 0,
      outcome TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS market_regime (
      id TEXT PRIMARY KEY,
      regime TEXT NOT NULL,
      spy_status TEXT,
      qqq_status TEXT,
      details_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS monitored_positions (
      id TEXT PRIMARY KEY,
      market_type TEXT,
      exchange TEXT,
      adapter_name TEXT,
      symbol TEXT NOT NULL,
      base_asset TEXT,
      quote_asset TEXT,
      product_id TEXT,
      side TEXT NOT NULL,
      alpaca_order_id TEXT,
      entry_order_id TEXT,
      exit_order_id TEXT,
      qty REAL,
      notional REAL,
      entry_price REAL,
      stop_loss REAL,
      take_profit REAL,
      current_price REAL,
      status TEXT NOT NULL,
      exit_reason TEXT,
      opened_at TEXT DEFAULT CURRENT_TIMESTAMP,
      closed_at TEXT,
      last_checked_at TEXT,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS system_events (
      id TEXT PRIMARY KEY,
      market_type TEXT,
      exchange TEXT,
      adapter_name TEXT,
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      event TEXT NOT NULL,
      message TEXT NOT NULL,
      payload TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      entry_price REAL NOT NULL,
      stop_loss REAL NOT NULL,
      take_profit REAL NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      strategy TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      expires_at TEXT,
      expired_at TEXT,
      expiration_reason TEXT,
      signal_price REAL,
      last_reviewed_at TEXT,
      review_price REAL,
      approval_price REAL,
      stale_status TEXT
      , market_type TEXT,
      exchange TEXT,
      base_asset TEXT,
      quote_asset TEXT,
      product_id TEXT,
      adapter_name TEXT
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      alpaca_order_id TEXT,
      signal_id TEXT,
      market_type TEXT,
      exchange TEXT,
      adapter_name TEXT,
      base_asset TEXT,
      quote_asset TEXT,
      product_id TEXT,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      notional REAL NOT NULL,
      status TEXT NOT NULL,
      raw_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS positions (
      symbol TEXT PRIMARY KEY,
      market_type TEXT,
      exchange TEXT,
      adapter_name TEXT,
      base_asset TEXT,
      quote_asset TEXT,
      product_id TEXT,
      qty REAL,
      market_value REAL,
      unrealized_pl REAL,
      raw_json TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      market_type TEXT,
      exchange TEXT,
      adapter_name TEXT,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      qty REAL,
      price REAL,
      pnl REAL,
      strategy TEXT,
      status TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS trade_journal (
      id TEXT PRIMARY KEY,
      trade_id TEXT UNIQUE,
      signal_id TEXT,
      symbol TEXT NOT NULL,
      strategy_name TEXT,
      scanner_preset TEXT,
      market_type TEXT,
      exchange TEXT,
      adapter_name TEXT,
      market_regime TEXT,
      entry_price REAL,
      exit_price REAL,
      qty REAL,
      notional REAL,
      stop_loss REAL,
      take_profit REAL,
      realized_pnl REAL,
      realized_pnl_percent REAL,
      risk_amount REAL,
      reward_amount REAL,
      rr_planned REAL,
      rr_actual REAL,
      exit_reason TEXT,
      protection_mode TEXT,
      approved_at TEXT,
      opened_at TEXT,
      closed_at TEXT,
      duration_seconds INTEGER,
      notes TEXT,
      mistake_tags TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS performance_daily (
      day TEXT PRIMARY KEY,
      trades INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      realized_pnl REAL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS strategy_stats (
      strategy_name TEXT PRIMARY KEY,
      trades INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      realized_pnl REAL DEFAULT 0,
      profit_factor REAL DEFAULT 0,
      expectancy REAL DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS signal_outcomes (
      signal_id TEXT PRIMARY KEY,
      market_type TEXT,
      exchange TEXT,
      adapter_name TEXT,
      symbol TEXT NOT NULL,
      generated_at TEXT,
      direction TEXT,
      confidence REAL,
      entry REAL,
      stop_loss REAL,
      take_profit REAL,
      market_regime TEXT,
      scanner_preset TEXT,
      status TEXT,
      max_favorable_move REAL,
      max_adverse_move REAL,
      would_hit_target INTEGER,
      would_hit_stop INTEGER,
      outcome_checked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS risk_events (
      id TEXT PRIMARY KEY,
      signal_id TEXT,
      symbol TEXT,
      reason TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS system_logs (
      id TEXT PRIMARY KEY,
      level TEXT NOT NULL,
      event TEXT NOT NULL,
      payload TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `));

  const addColumn = (table, name, definition) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
    if (!columns.includes(name)) withRetry(() => db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`));
  };
  const addSignalColumn = (name, definition) => addColumn('signals', name, definition);
  addSignalColumn('expires_at', 'TEXT');
  addSignalColumn('expired_at', 'TEXT');
  addSignalColumn('expiration_reason', 'TEXT');
  addSignalColumn('signal_price', 'REAL');
  addSignalColumn('last_reviewed_at', 'TEXT');
  addSignalColumn('review_price', 'REAL');
  addSignalColumn('approval_price', 'REAL');
  addSignalColumn('stale_status', 'TEXT');
  ['market_type', 'exchange', 'base_asset', 'quote_asset', 'product_id', 'adapter_name'].forEach((name) => addSignalColumn(name, 'TEXT'));
  ['market_type', 'exchange', 'adapter_name'].forEach((name) => addColumn('scanner_runs', name, 'TEXT'));
  ['market_type', 'exchange', 'adapter_name', 'base_asset', 'quote_asset', 'product_id'].forEach((name) => addColumn('monitored_positions', name, 'TEXT'));
  ['market_type', 'exchange', 'adapter_name', 'base_asset', 'quote_asset', 'product_id'].forEach((name) => addColumn('orders', name, 'TEXT'));
  ['market_type', 'exchange', 'adapter_name', 'base_asset', 'quote_asset', 'product_id'].forEach((name) => addColumn('positions', name, 'TEXT'));
  ['market_type', 'exchange', 'adapter_name'].forEach((name) => addColumn('trades', name, 'TEXT'));
  ['market_type', 'exchange', 'adapter_name'].forEach((name) => addColumn('trade_journal', name, 'TEXT'));
  ['market_type', 'exchange', 'adapter_name', 'product_id'].forEach((name) => addColumn('trading_universe_candidates', name, 'TEXT'));
  ['indicators_json', 'signal_gate_json', 'blockers_json'].forEach((name) => addColumn('trading_universe_candidates', name, 'TEXT'));
  ['market_type', 'exchange', 'adapter_name', 'product_id'].forEach((name) => addColumn('candidate_history', name, 'TEXT'));
  ['price', 'score', 'volume', 'relative_volume', 'momentum_15m', 'momentum_1h', 'spread_percent'].forEach((name) => addColumn('candidate_history', name, 'REAL'));
  ['probability', 'needs_json', 'signal_status', 'signal_generation_status', 'outcome'].forEach((name) => addColumn('candidate_history', name, 'TEXT'));
  addColumn('candidate_history', 'was_near_miss', 'INTEGER DEFAULT 0');
  ['market_type', 'exchange', 'adapter_name'].forEach((name) => addColumn('system_events', name, 'TEXT'));
  ['market_type', 'exchange', 'adapter_name'].forEach((name) => addColumn('signal_outcomes', name, 'TEXT'));

  const defaults = ['SPY', 'QQQ', 'IWM', 'DIA', 'NVDA', 'AMD', 'AAPL', 'MSFT'];
  const insertWatch = db.prepare('INSERT OR IGNORE INTO watchlist (symbol) VALUES (?)');
  defaults.forEach((symbol) => withRetry(() => insertWatch.run(symbol)));

  const insertGroup = db.prepare('INSERT OR IGNORE INTO watchlist_groups (symbol, group_name) VALUES (?, ?)');
  defaults.forEach((symbol) => withRetry(() => insertGroup.run(symbol, 'market_context')));
  defaults.forEach((symbol) => withRetry(() => insertGroup.run(symbol, 'stock_market_context')));
  ['SOFI', 'PLTR', 'RIVN', 'LCID', 'F', 'PFE', 'NIO', 'HOOD', 'SNAP', 'INTC', 'AMD', 'TSLA', 'AAPL', 'MSFT', 'NVDA', 'MARA', 'RIOT', 'BAC', 'T', 'WBD']
    .forEach((symbol) => withRetry(() => insertGroup.run(symbol, 'trading_universe')));
  ['SOFI', 'PLTR', 'RIVN', 'LCID', 'F', 'PFE', 'NIO', 'HOOD', 'SNAP', 'INTC', 'AMD', 'TSLA', 'AAPL', 'MSFT', 'NVDA', 'MARA', 'RIOT', 'BAC', 'T', 'WBD']
    .forEach((symbol) => withRetry(() => insertGroup.run(symbol, 'stock_trading_universe')));
  ['BTC-USD', 'ETH-USD', 'SOL-USD'].forEach((symbol) => withRetry(() => insertGroup.run(symbol, 'crypto_major')));
  ['LINK-USD', 'AVAX-USD', 'ADA-USD', 'DOGE-USD', 'XRP-USD', 'LTC-USD', 'BCH-USD'].forEach((symbol) => withRetry(() => insertGroup.run(symbol, 'crypto_alt')));

  const setDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  Object.entries({
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
    max_results: String(config.scanner.maxResults)
    , primary_market: config.primaryMarket,
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
    signal_mode: 'strict'
  }).forEach(([key, value]) => withRetry(() => setDefault.run(key, value)));
}

export function logEvent(level, event, payload = {}) {
  withRetry(() => db.prepare('INSERT INTO system_logs (id, level, event, payload) VALUES (?, ?, ?, ?)')
    .run(nanoid(), level, event, JSON.stringify(payload)));
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  withRetry(() => db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, String(value)));
}

export function allSettings() {
  return db.prepare('SELECT key, value FROM settings').all()
    .reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {});
}
