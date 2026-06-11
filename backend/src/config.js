import dotenv from 'dotenv';

dotenv.config({ path: process.env.ENV_FILE || '../.env' });
dotenv.config();

const bool = (value, fallback = false) => {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === 'true';
};

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeAlpacaBaseUrl = (value) => {
  const fallback = 'https://api.alpaca.markets';
  const raw = String(value || fallback).trim().replace(/\/+$/, '');
  return raw.replace(/\/v2$/i, '');
};

const normalizeOrigin = (value, fallback = 'http://localhost:5173') => {
  const raw = String(value || fallback).trim().replace(/\/+$/, '');
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
};

export const config = {
  port: num(process.env.PORT, 4000),
  primaryMarket: process.env.PRIMARY_MARKET || 'crypto',
  activeExchange: process.env.ACTIVE_EXCHANGE || 'coinbase',
  enableStocksModule: bool(process.env.ENABLE_STOCKS_MODULE, true),
  enableCryptoModule: bool(process.env.ENABLE_CRYPTO_MODULE, true),
  enableForexModule: bool(process.env.FOREX_MODULE_ENABLED ?? process.env.ENABLE_FOREX_MODULE, true),
  alpacaApiKey: process.env.ALPACA_API_KEY || '',
  alpacaSecretKey: process.env.ALPACA_SECRET_KEY || '',
  alpacaBaseUrl: normalizeAlpacaBaseUrl(process.env.ALPACA_BASE_URL),
  alpacaDataFeed: process.env.ALPACA_DATA_FEED || 'iex',
  tradingMode: process.env.TRADING_MODE || 'live',
  autoExecution: bool(process.env.AUTO_EXECUTION, false),
  maxDailyLoss: num(process.env.MAX_DAILY_LOSS, 1),
  maxTradeRisk: num(process.env.MAX_TRADE_RISK, 0.25),
  maxPositionNotional: num(process.env.MAX_POSITION_NOTIONAL, 5),
  maxOpenPositions: num(process.env.MAX_OPEN_POSITIONS, 1),
  enableContextSymbolTrading: bool(process.env.ENABLE_CONTEXT_SYMBOL_TRADING, false),
  riskPerTradePercent: num(process.env.RISK_PER_TRADE_PERCENT, 1),
  maxAccountPositionPercent: num(process.env.MAX_ACCOUNT_POSITION_PERCENT, 25),
  maxDailyLossPercent: num(process.env.MAX_DAILY_LOSS_PERCENT, 5),
  minNotionalOrder: num(process.env.MIN_NOTIONAL_ORDER, 1),
  allowFractionalEntries: bool(process.env.ALLOW_FRACTIONAL_ENTRIES, true),
  protectionMode: process.env.PROTECTION_MODE || 'auto',
  monitoredExitIntervalMs: num(process.env.MONITORED_EXIT_INTERVAL_MS, 5000),
  monitoredExitMaxStaleSeconds: num(process.env.MONITORED_EXIT_MAX_STALE_SECONDS, 20),
  allowMonitoredFractionalExits: bool(process.env.ALLOW_MONITORED_FRACTIONAL_EXITS, true),
  signalTtlSeconds: num(process.env.SIGNAL_TTL_SECONDS, 300),
  maxEntrySlippagePercent: num(process.env.MAX_ENTRY_SLIPPAGE_PERCENT, 0.5),
  maxExtensionFromSignalPercent: num(process.env.MAX_EXTENSION_FROM_SIGNAL_PERCENT, 1.0),
  requireFreshReviewBeforeApproval: bool(process.env.REQUIRE_FRESH_REVIEW_BEFORE_APPROVAL, true),
  coinbaseApiKeyName: process.env.COINBASE_API_KEY_NAME || '',
  coinbaseApiPrivateKey: process.env.COINBASE_API_PRIVATE_KEY || '',
  coinbaseApiBaseUrl: process.env.COINBASE_API_BASE_URL || 'https://api.coinbase.com/api/v3/brokerage',
  coinbasePublicBaseUrl: process.env.COINBASE_PUBLIC_BASE_URL || 'https://api.exchange.coinbase.com',
  coinbaseWsUrl: process.env.COINBASE_WS_URL || '',
  cryptoTradingEnabled: bool(process.env.CRYPTO_TRADING_ENABLED, true),
  cryptoAutoExecution: bool(process.env.CRYPTO_AUTO_EXECUTION, false),
  cryptoRiskPerTradePercent: num(process.env.CRYPTO_RISK_PER_TRADE_PERCENT, 1),
  cryptoMaxAccountPositionPercent: num(process.env.CRYPTO_MAX_ACCOUNT_POSITION_PERCENT, 25),
  cryptoMaxDailyLossPercent: num(process.env.CRYPTO_MAX_DAILY_LOSS_PERCENT, 5),
  cryptoMaxOpenPositions: num(process.env.CRYPTO_MAX_OPEN_POSITIONS, 1),
  cryptoMinNotionalOrder: num(process.env.CRYPTO_MIN_NOTIONAL_ORDER, 1),
  cryptoStopLossPercent: num(process.env.CRYPTO_STOP_LOSS_PERCENT, 1.5),
  cryptoTakeProfitPercent: num(process.env.CRYPTO_TAKE_PROFIT_PERCENT, 3),
  cryptoMaxSpreadPercent: num(process.env.CRYPTO_MAX_SPREAD_PERCENT, 0.35),
  cryptoMaxSlippagePercent: num(process.env.CRYPTO_MAX_SLIPPAGE_PERCENT, 0.5),
  cryptoCooldownAfterLossMinutes: num(process.env.CRYPTO_COOLDOWN_AFTER_LOSS_MINUTES, 15),
  cryptoDailyTradeLimit: num(process.env.CRYPTO_DAILY_TRADE_LIMIT, 10),
  allowCounterRegimeTrades: bool(process.env.ALLOW_COUNTER_REGIME_TRADES, false),
  enableLegacyCryptoStrategy: false,
  blockLongsInBearishRegime: bool(process.env.BLOCK_LONGS_IN_BEARISH_REGIME, true),
  allowNeutralLongs: bool(process.env.ALLOW_NEUTRAL_LONGS, false),
  minV2SignalQuality: num(process.env.MIN_V2_SIGNAL_QUALITY, 0.60),
  minV2RiskReward: num(process.env.MIN_V2_RISK_REWARD, 1.5),
  maxDistanceFromVwapPercent: num(process.env.MAX_DISTANCE_FROM_VWAP_PERCENT, 1.5),
  maxDistanceFromEma20Percent: num(process.env.MAX_DISTANCE_FROM_EMA20_PERCENT, 1.75),
  minPullbackDepthPercent: num(process.env.MIN_PULLBACK_DEPTH_PERCENT, 0.15),
  maxPullbackDepthPercent: num(process.env.MAX_PULLBACK_DEPTH_PERCENT, 3.0),
  minReclaimStrengthPercent: num(process.env.MIN_RECLAIM_STRENGTH_PERCENT, 0.05),
  min15mMomentum: num(process.env.MIN_15M_MOMENTUM, 0.05),
  min1hMomentum: num(process.env.MIN_1H_MOMENTUM, 0.10),
  forexBroker: process.env.FOREX_BROKER || 'forex.com',
  forexTradingEnabled: bool(process.env.FOREX_TRADING_ENABLED, false),
  forexAutoExecution: bool(process.env.FOREX_AUTO_EXECUTION, false),
  forexApiBaseUrl: process.env.FOREX_API_BASE_URL || '',
  forexStreamUrl: process.env.FOREX_STREAM_URL || '',
  forexApiKey: process.env.FOREX_API_KEY || '',
  forexUsername: process.env.FOREX_USERNAME || '',
  forexPassword: process.env.FOREX_PASSWORD || '',
  forexAccountId: process.env.FOREX_ACCOUNT_ID || '',
  forexAppKey: process.env.FOREX_APP_KEY || '',
  forexEnv: process.env.FOREX_ENV || 'demo',
  forexRiskPerTradePercent: num(process.env.FOREX_RISK_PER_TRADE_PERCENT, 1),
  forexMaxDailyLossPercent: num(process.env.FOREX_MAX_DAILY_LOSS_PERCENT, 3),
  forexMaxOpenPositions: num(process.env.FOREX_MAX_OPEN_POSITIONS, 1),
  forexMaxSpreadPips: num(process.env.FOREX_MAX_SPREAD_PIPS, 2),
  forexMinRiskReward: num(process.env.FOREX_MIN_RISK_REWARD, 1.5),
  forexAllowLeverage: bool(process.env.FOREX_ALLOW_LEVERAGE, false),
  forexSessionFilter: bool(process.env.FOREX_SESSION_FILTER, true),
  autoCryptoScanner: bool(process.env.AUTO_CRYPTO_SCANNER, true),
  cryptoScannerIntervalMs: num(process.env.CRYPTO_SCANNER_INTERVAL_MS, 60000),
  cryptoScanner: {
    minPrice: num(process.env.MIN_CRYPTO_PRICE, 0.01),
    maxPrice: num(process.env.MAX_CRYPTO_PRICE, 1000000),
    min24hVolumeUsd: num(process.env.MIN_24H_VOLUME_USD, 1000000),
    minRelativeVolume: num(process.env.MIN_RELATIVE_VOLUME, 1.0),
    minPercentChange15m: num(process.env.MIN_PERCENT_CHANGE_15M, 0.15),
    minPercentChange1h: num(process.env.MIN_PERCENT_CHANGE_1H, 0.25),
    maxSpreadPercent: num(process.env.MAX_SPREAD_PERCENT, 0.25),
    minCandleCount: num(process.env.MIN_CANDLE_COUNT, 50),
    excludeStablecoins: bool(process.env.EXCLUDE_STABLECOINS, true),
    maxResults: num(process.env.MAX_RESULTS, 25)
  },
  scanner: {
    minPrice: num(process.env.MIN_PRICE, 1),
    maxPrice: num(process.env.MAX_PRICE, 500),
    minDailyVolume: num(process.env.MIN_DAILY_VOLUME, 1000000),
    minRelativeVolume: num(process.env.MIN_RELATIVE_VOLUME, 1.2),
    maxSpreadPercent: num(process.env.MAX_SPREAD_PERCENT, 0.5),
    minPercentChange: num(process.env.MIN_PERCENT_CHANGE, 0.5),
    excludeOtc: bool(process.env.EXCLUDE_OTC, true),
    requireActive: bool(process.env.REQUIRE_ACTIVE, true),
    requireTradable: bool(process.env.REQUIRE_TRADABLE, true),
    preferFractionable: bool(process.env.PREFER_FRACTIONABLE, true),
    excludeLeveragedEtfs: bool(process.env.EXCLUDE_LEVERAGED_ETFS, true),
    maxResults: num(process.env.MAX_RESULTS, 50)
  },
  quantServiceUrl: process.env.QUANT_SERVICE_URL || 'http://localhost:8000',
  mongodbUri: process.env.MONGODB_URI || '',
  mongodbDatabase: process.env.MONGODB_DB_NAME || process.env.MONGODB_DATABASE || 'signalflow',
  frontendOrigin: normalizeOrigin(process.env.FRONTEND_ORIGIN)
};

export const executionMode = () => (
  config.autoExecution ? 'LIVE_AUTO_EXECUTION' : 'SAFE_MANUAL_APPROVAL'
);
