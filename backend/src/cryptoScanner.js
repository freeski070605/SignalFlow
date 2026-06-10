import { nanoid } from 'nanoid';
import { config } from './config.js';
import { collections, getSetting, nowIso, setSetting, withoutMongoIds } from './db.js';
import { emitEvent } from './events.js';
import { coinbaseCryptoAdapter, cryptoMajors, cryptoUniverse } from './adapters/coinbaseCryptoAdapter.js';
import { evaluateCryptoStrategyV2, cryptoStrategyV2Settings, V2_SETUP_TYPE, V2_STRATEGY_NAME } from './cryptoStrategyV2.js';
import { historicalOutcomeRows } from './strategyLearning.js';

const stable = new Set(['USDC-USD', 'USDT-USD', 'DAI-USD']);
const maxQuoteAgeMs = 60_000;

export const cryptoScannerPresets = {
  crypto_conservative: { universe: 'majors', min24hVolumeUsd: 50000000, maxSpreadPercent: 0.15, minPercentChange15m: 0.1 },
  crypto_micro_account: { universe: 'all', min24hVolumeUsd: 1000000, maxSpreadPercent: 0.35, minPercentChange15m: 0.15 },
  crypto_momentum_hunt: { universe: 'all', min24hVolumeUsd: 5000000, maxSpreadPercent: 0.5, minPercentChange15m: 0.5 }
};

const num = (key, fallback) => {
  const parsed = Number(getSetting(key, fallback));
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBool = (value, fallback = false) => {
  if (value === undefined || value === null) return fallback;
  return String(value).toLowerCase() === 'true';
};

const signalModePresets = {
  strict: {
    allowCounterRegimeTrades: false,
    requirePriceAboveVwap: true,
    requireEma9AboveEma20: true,
    requirePositive15mMomentum: true,
    rsiMin: 45,
    rsiMax: 75,
    maxSignalSpreadPercent: 0.35,
    minSignalScore: 70
  },
  balanced: {
    allowCounterRegimeTrades: false,
    requirePriceAboveVwap: false,
    requireEma9AboveEma20: true,
    requirePositive15mMomentum: true,
    rsiMin: 40,
    rsiMax: 80,
    maxSignalSpreadPercent: 0.35,
    minSignalScore: 60
  },
  discovery: {
    allowCounterRegimeTrades: true,
    requirePriceAboveVwap: false,
    requireEma9AboveEma20: false,
    requirePositive15mMomentum: false,
    rsiMin: 35,
    rsiMax: 85,
    maxSignalSpreadPercent: 0.35,
    minSignalScore: 50
  }
};

const signalSettingKeys = {
  allowCounterRegimeTrades: 'allow_counter_regime_trades',
  requirePriceAboveVwap: 'require_price_above_vwap',
  requireEma9AboveEma20: 'require_ema9_above_ema20',
  requirePositive15mMomentum: 'require_positive_15m_momentum',
  rsiMin: 'rsi_min',
  rsiMax: 'rsi_max',
  maxSignalSpreadPercent: 'max_signal_spread_percent',
  minSignalScore: 'min_signal_score',
  signalMode: 'signal_mode'
};

const allowedSignalModes = new Set(Object.keys(signalModePresets));

function normalizedSignalMode(value) {
  return allowedSignalModes.has(value) ? value : 'strict';
}

function strategySettingsFromStorage() {
  const signalMode = normalizedSignalMode(getSetting('signal_mode', 'strict'));
  const preset = signalModePresets[signalMode];
  return {
    signalMode,
    allowCounterRegimeTrades: toBool(getSetting('allow_counter_regime_trades'), preset.allowCounterRegimeTrades),
    requirePriceAboveVwap: toBool(getSetting('require_price_above_vwap'), preset.requirePriceAboveVwap),
    requireEma9AboveEma20: toBool(getSetting('require_ema9_above_ema20'), preset.requireEma9AboveEma20),
    requirePositive15mMomentum: toBool(getSetting('require_positive_15m_momentum'), preset.requirePositive15mMomentum),
    rsiMin: num('rsi_min', preset.rsiMin),
    rsiMax: num('rsi_max', preset.rsiMax),
    maxSignalSpreadPercent: num('max_signal_spread_percent', preset.maxSignalSpreadPercent),
    minSignalScore: Math.max(num('min_signal_score', preset.minSignalScore), preset.minSignalScore),
    ...cryptoStrategyV2Settings(),
    min24hVolumeUsd: num('min_24h_volume_usd', config.cryptoScanner.min24hVolumeUsd)
  };
}

export function cryptoStrategySettings() {
  return strategySettingsFromStorage();
}

export function cryptoStrategySettingsPayload() {
  return { settings: cryptoStrategySettings(), presets: signalModePresets, allowedSignalModes: [...allowedSignalModes] };
}

export function saveCryptoStrategySettings(input = {}) {
  const current = cryptoStrategySettings();
  const signalMode = input.signalMode !== undefined ? normalizedSignalMode(input.signalMode) : current.signalMode;
  const modeChanged = signalMode !== current.signalMode;
  const preset = signalModePresets[signalMode];
  const next = {
    ...(modeChanged ? preset : current),
    signalMode
  };

  Object.keys(signalSettingKeys).forEach((publicKey) => {
    if (publicKey === 'signalMode') return;
    if (input[publicKey] !== undefined && input[publicKey] !== '') next[publicKey] = input[publicKey];
  });

  setSetting('signal_mode', signalMode);
  Object.entries(signalSettingKeys).forEach(([publicKey, dbKey]) => {
    if (publicKey === 'signalMode') return;
    setSetting(dbKey, next[publicKey]);
  });
  const v2Keys = {
    enableLegacyCryptoStrategy: 'enable_legacy_crypto_strategy',
    blockLongsInBearishRegime: 'block_longs_in_bearish_regime',
    allowNeutralLongs: 'allow_neutral_longs',
    minV2SignalQuality: 'min_v2_signal_quality',
    minV2RiskReward: 'min_v2_risk_reward',
    maxDistanceFromVwapPercent: 'max_distance_from_vwap_percent',
    maxDistanceFromEma20Percent: 'max_distance_from_ema20_percent',
    minPullbackDepthPercent: 'min_pullback_depth_percent',
    maxPullbackDepthPercent: 'max_pullback_depth_percent',
    minReclaimStrengthPercent: 'min_reclaim_strength_percent',
    minRelativeVolume: 'min_v2_relative_volume',
    min15mMomentum: 'min_15m_momentum',
    min1hMomentum: 'min_1h_momentum'
  };
  Object.entries(v2Keys).forEach(([publicKey, dbKey]) => {
    if (input[publicKey] !== undefined && input[publicKey] !== '') setSetting(dbKey, input[publicKey]);
  });
  return cryptoStrategySettings();
}

export function cryptoScannerSettings() {
  return {
    minPrice: num('min_crypto_price', config.cryptoScanner.minPrice),
    maxPrice: num('max_crypto_price', config.cryptoScanner.maxPrice),
    min24hVolumeUsd: num('min_24h_volume_usd', config.cryptoScanner.min24hVolumeUsd),
    minRelativeVolume: num('crypto_min_relative_volume', config.cryptoScanner.minRelativeVolume),
    minPercentChange15m: num('min_percent_change_15m', config.cryptoScanner.minPercentChange15m),
    minPercentChange1h: num('min_percent_change_1h', config.cryptoScanner.minPercentChange1h),
    maxSpreadPercent: num('crypto_max_spread_percent', config.cryptoScanner.maxSpreadPercent),
    minCandleCount: num('min_candle_count', config.cryptoScanner.minCandleCount),
    excludeStablecoins: String(getSetting('exclude_stablecoins', config.cryptoScanner.excludeStablecoins)).toLowerCase() === 'true',
    maxResults: num('crypto_max_results', config.cryptoScanner.maxResults),
    activePreset: getSetting('active_crypto_scanner_preset', 'crypto_micro_account')
  };
}

export function saveCryptoScannerSettings(input = {}) {
  const keys = {
    minPrice: 'min_crypto_price',
    maxPrice: 'max_crypto_price',
    min24hVolumeUsd: 'min_24h_volume_usd',
    minRelativeVolume: 'crypto_min_relative_volume',
    minPercentChange15m: 'min_percent_change_15m',
    minPercentChange1h: 'min_percent_change_1h',
    maxSpreadPercent: 'crypto_max_spread_percent',
    minCandleCount: 'min_candle_count',
    maxResults: 'crypto_max_results'
  };
  Object.entries(keys).forEach(([key, setting]) => {
    if (input[key] !== undefined && input[key] !== '') setSetting(setting, input[key]);
  });
  if (input.activePreset) setSetting('active_crypto_scanner_preset', input.activePreset);
  setSetting('exclude_stablecoins', input.excludeStablecoins ?? true);
  return cryptoScannerSettings();
}

export function applyCryptoPreset(name) {
  const preset = cryptoScannerPresets[name];
  if (!preset) throw new Error(`Unknown crypto scanner preset: ${name}`);
  return saveCryptoScannerSettings({ ...preset, activePreset: name });
}

function ema(values, period) {
  const k = 2 / (period + 1);
  return values.reduce((prev, value, index) => index === 0 ? value : value * k + prev * (1 - k), values[0] || 0);
}

function rsi(values, period = 14) {
  const slice = values.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < slice.length; i += 1) {
    const diff = slice[i] - slice[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (!losses) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function vwap(candles) {
  const totals = candles.reduce((acc, row) => {
    const typical = (Number(row.high) + Number(row.low) + Number(row.close)) / 3;
    acc.pv += typical * Number(row.volume || 0);
    acc.volume += Number(row.volume || 0);
    return acc;
  }, { pv: 0, volume: 0 });
  return totals.volume ? totals.pv / totals.volume : 0;
}

function percentChange(values, periods) {
  if (values.length <= periods) return 0;
  const current = values.at(-1);
  const previous = values.at(-1 - periods);
  return previous ? ((current - previous) / previous) * 100 : 0;
}

function summarizeRejections(rows) {
  const counts = new Map();
  rows.forEach((row) => String(row.reason || '').split(';').map((item) => item.trim()).filter(Boolean).forEach((reason) => counts.set(reason, (counts.get(reason) || 0) + 1)));
  return [...counts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

function isProductTradable(product) {
  if (!product) return false;
  const status = String(product.status || '').toLowerCase();
  return product.quote_currency === 'USD'
    && !product.trading_disabled
    && !product.cancel_only
    && !product.limit_only
    && !product.post_only
    && !['offline', 'delisted'].includes(status);
}

async function productsById() {
  const products = await coinbaseCryptoAdapter.getProducts();
  return new Map(products.map((product) => [String(product.id || product.product_id || '').toUpperCase(), product]));
}

function quoteTimestamp(ticker) {
  const rawTime = ticker?.raw?.time || ticker?.raw?.trade_id_time;
  const parsed = rawTime ? new Date(rawTime).getTime() : Date.now();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

async function cryptoSafetyContext() {
  const [positions, balances] = await Promise.all([
    coinbaseCryptoAdapter.getOpenPositions().catch(() => []),
    coinbaseCryptoAdapter.getBalances().catch(() => [])
  ]);
  const usd = balances.find((row) => row.asset === 'USD');
  const equity = Number(usd?.available || 0);
  const today = new Date().toISOString().slice(0, 10);
  const journalRows = await collections.tradeJournal.find({ market_type: 'crypto' }).toArray();
  const realizedPnl = journalRows
    .filter((row) => String(row.closed_at || row.created_at || '').startsWith(today))
    .reduce((sum, row) => sum + Number(row.realized_pnl || 0), 0);
  const maxDailyLossDollars = equity > 0 ? equity * (num('crypto_max_daily_loss_percent', config.cryptoMaxDailyLossPercent) / 100) : 0;
  const pendingSignals = await collections.signals.find({ status: 'pending', market_type: 'crypto' }, { projection: { symbol: 1 } }).toArray();
  return {
    killSwitchActive: getSetting('kill_switch', 'false') === 'true',
    openPositionSymbols: new Set(positions.map((row) => row.symbol)),
    pendingSignalSymbols: new Set(pendingSignals.map((row) => row.symbol)),
    maxDailyLossHit: maxDailyLossDollars > 0 && realizedPnl <= -maxDailyLossDollars
  };
}

function countGate(summary, key) {
  summary[key] = (summary[key] || 0) + 1;
}

function signalGateSummary(rows) {
  const summary = {
    scanned: rows.length,
    passedScannerFilters: rows.filter((row) => row.passed).length,
    createdPendingSignals: 0,
    blockedByRegime: 0,
    failedVwap: 0,
    failedEma: 0,
    failedRsi: 0,
    failedMomentum: 0,
    failedScore: 0,
    failedSpread: 0,
    duplicatePending: 0,
    alreadyInPosition: 0,
    missingCandleData: 0,
    missingQuoteData: 0
  };

  rows.forEach((row) => {
    if (['created_signal', 'discovery_risk'].includes(row.signal_generation_status)) summary.createdPendingSignals += 1;
    const gates = row.signal_gate?.failedGates || [];
    gates.forEach((gate) => {
      if (gate.key === 'regime' && row.signal_gate?.wouldCreateSignal === false) countGate(summary, 'blockedByRegime');
      if (gate.key === 'vwap') countGate(summary, 'failedVwap');
      if (gate.key === 'ema') countGate(summary, 'failedEma');
      if (gate.key === 'rsi') countGate(summary, 'failedRsi');
      if (gate.key === 'momentum') countGate(summary, 'failedMomentum');
      if (gate.key === 'score') countGate(summary, 'failedScore');
      if (gate.key === 'spread') countGate(summary, 'failedSpread');
      if (gate.key === 'duplicate') countGate(summary, 'duplicatePending');
      if (gate.key === 'already_in_position') countGate(summary, 'alreadyInPosition');
      if (gate.key === 'missing_candle_data') countGate(summary, 'missingCandleData');
      if (gate.key === 'missing_quote_data') countGate(summary, 'missingQuoteData');
    });
    const reason = String(row.reason || row.signal_generation_reason || '').toLowerCase();
    if (reason.includes('candle')) countGate(summary, 'missingCandleData');
    if (reason.includes('quote') || reason.includes('ticker') || reason.includes('missing price')) countGate(summary, 'missingQuoteData');
  });
  return summary;
}

function topBlockerFromSummary(summary) {
  const labels = [
    ['blockedByRegime', 'blocked by regime'],
    ['failedSpread', 'spread too wide'],
    ['failedScore', 'score below signal minimum'],
    ['failedVwap', 'price below VWAP'],
    ['failedEma', 'EMA9 not above EMA20'],
    ['failedRsi', 'RSI outside range'],
    ['failedMomentum', '15m momentum not positive'],
    ['duplicatePending', 'duplicate pending signal'],
    ['alreadyInPosition', 'already in position'],
    ['missingCandleData', 'missing candle data'],
    ['missingQuoteData', 'missing quote data']
  ];
  const top = labels.sort((a, b) => Number(summary[b[0]] || 0) - Number(summary[a[0]] || 0))[0];
  return top && Number(summary[top[0]] || 0) > 0 ? top[1] : 'none';
}

const opportunityHardBlockers = new Set([
  'product_tradable',
  'blocked_symbol',
  'missing_quote_data',
  'quote_fresh',
  'missing_candle_data',
  'kill_switch',
  'max_daily_loss',
  'duplicate',
  'already_in_position'
]);

function positiveGap(required, actual, decimals = 2) {
  const gap = Number(required || 0) - Number(actual || 0);
  return gap > 0 ? Number(gap.toFixed(decimals)) : 0;
}

function opportunityNeedList(row, scannerSettings, strategySettings) {
  const indicators = row.indicators || {};
  const percentChange15m = Number(row.percent_change_15m ?? indicators.percentChange15m ?? 0);
  const percentChange1h = Number(row.percent_change_1h ?? indicators.percentChange1h ?? 0);
  const relativeVolume = Number(row.relative_volume ?? indicators.relativeVolume ?? 0);
  const score = Number(row.score || 0);
  const spread = Number(row.spread_percent || 0);
  const needs = [];
  const addNeed = (key, amount, label, priority) => {
    if (amount > 0) needs.push({ key, amount, label, priority });
  };

  const momentum15mGap = positiveGap(scannerSettings.minPercentChange15m, percentChange15m, 2);
  addNeed('momentum15m', momentum15mGap, `+${momentum15mGap.toFixed(2)}% more 15m momentum`, 1);

  const relativeVolumeGap = positiveGap(scannerSettings.minRelativeVolume, relativeVolume, 2);
  addNeed('relativeVolume', relativeVolumeGap, `+${relativeVolumeGap.toFixed(2)} relative volume`, 2);

  const momentum1hGap = positiveGap(scannerSettings.minPercentChange1h, percentChange1h, 2);
  addNeed('momentum1h', momentum1hGap, `+${momentum1hGap.toFixed(2)}% more 1h momentum`, 3);

  const scoreGap = positiveGap(strategySettings.minSignalScore, score, 1);
  addNeed('score', scoreGap, `+${scoreGap.toFixed(1)} score`, 4);

  const spreadGap = positiveGap(spread, Math.min(Number(scannerSettings.maxSpreadPercent || Infinity), Number(strategySettings.maxSignalSpreadPercent || Infinity)), 2);
  if (spreadGap > 0) needs.push({ key: 'spread', amount: spreadGap, label: `-${spreadGap.toFixed(2)}% spread`, priority: 5 });

  const rsi = Number(indicators.rsi14 || 0);
  if (rsi && rsi < Number(strategySettings.rsiMin)) {
    needs.push({ key: 'rsi', amount: Number((Number(strategySettings.rsiMin) - rsi).toFixed(1)), label: `RSI +${(Number(strategySettings.rsiMin) - rsi).toFixed(1)}`, priority: 6 });
  } else if (rsi && rsi > Number(strategySettings.rsiMax)) {
    needs.push({ key: 'rsi', amount: Number((rsi - Number(strategySettings.rsiMax)).toFixed(1)), label: `RSI -${(rsi - Number(strategySettings.rsiMax)).toFixed(1)}`, priority: 6 });
  }

  return needs.sort((a, b) => a.priority - b.priority).slice(0, 4);
}

function opportunityProbability(row, needs) {
  const score = Number(row.score || 0);
  const hardNeed = needs.find((need) => (
    (need.key === 'momentum15m' && need.amount > 0.25)
    || (need.key === 'relativeVolume' && need.amount > 0.35)
    || (need.key === 'momentum1h' && need.amount > 0.5)
    || (need.key === 'score' && need.amount > 10)
    || need.key === 'spread'
    || need.key === 'rsi'
  ));
  if (!hardNeed && needs.length <= 3 && score >= 65) return 'HIGH';
  if (needs.length <= 4 && score >= 55) return 'MEDIUM';
  return 'LOW';
}

function opportunityRequirementValue(need, scannerSettings, strategySettings) {
  const values = {
    momentum15m: Number(scannerSettings.minPercentChange15m || 0),
    relativeVolume: Number(scannerSettings.minRelativeVolume || 0),
    momentum1h: Number(scannerSettings.minPercentChange1h || 0),
    score: Number(strategySettings.minSignalScore || 0),
    spread: Math.min(Number(scannerSettings.maxSpreadPercent || Infinity), Number(strategySettings.maxSignalSpreadPercent || Infinity)),
    rsi: Math.max(1, Number(strategySettings.rsiMax || 0) - Number(strategySettings.rsiMin || 0))
  };
  return Number.isFinite(values[need.key]) ? Math.abs(values[need.key]) : 0;
}

function withinTenPercentOfSignalRequirements(candidate, scannerSettings, strategySettings) {
  const needs = candidate.needs || [];
  if (!needs.length) return false;
  return needs.every((need) => {
    const requirement = opportunityRequirementValue(need, scannerSettings, strategySettings);
    return requirement > 0 && Number(need.amount || 0) <= requirement * 0.1;
  });
}

function signalOpportunityMonitor(rows, scannerSettings, strategySettings) {
  const nearMisses = rows
    .filter((row) => {
      const gate = row.signal_gate || {};
      if (gate.wouldCreateSignal) return false;
      if (!Number(row.price || 0) || row.error_gate) return false;
      const failedKeys = new Set((gate.failedGates || []).map((failedGate) => failedGate.key));
      return ![...failedKeys].some((key) => opportunityHardBlockers.has(key));
    })
    .map((row) => {
      const needs = opportunityNeedList(row, scannerSettings, strategySettings);
      const probability = opportunityProbability(row, needs);
      return {
        symbol: row.symbol,
        score: Number(row.score || 0),
        probability,
        needs,
        price: row.price,
        percentChange15m: row.percent_change_15m,
        relativeVolume: row.relative_volume,
        blockers: row.blockers || [],
        reason: row.signal_generation_reason || row.reason || ''
      };
    })
    .filter((row) => row.needs.length > 0 && row.probability !== 'LOW')
    .sort((a, b) => {
      const rank = { HIGH: 2, MEDIUM: 1, LOW: 0 };
      return (rank[b.probability] - rank[a.probability]) || (b.score - a.score);
    })
    .slice(0, 6);

  return {
    label: 'Near Misses',
    nearMisses,
    generatedAt: new Date().toISOString()
  };
}

async function recentlySentOpportunityAlert(symbol) {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const row = await collections.systemEvents.findOne({
    event: 'opportunity_alert',
    created_at: { $gte: cutoff },
    payload: { $regex: `"symbol":"${symbol}"` }
  });
  return Boolean(row);
}

async function emitOpportunityAlerts(runId, opportunityMonitor, scannerSettings, strategySettings) {
  const alerts = [];
  for (const candidate of (opportunityMonitor?.nearMisses || [])) {
    const highScore = Number(candidate.score || 0) > 75;
    const withinTenPercent = withinTenPercentOfSignalRequirements(candidate, scannerSettings, strategySettings);
    if (!highScore && !withinTenPercent) continue;
    if (await recentlySentOpportunityAlert(candidate.symbol)) continue;

    const needs = (candidate.needs || []).map((need) => need.label);
    const message = `${candidate.symbol} approaching signal. Current score: ${Number(candidate.score || 0).toFixed(1)}. Needs: ${needs.join('; ') || 'final confirmation'}.`;
    const payload = {
      runId,
      symbol: candidate.symbol,
      score: Number(candidate.score || 0),
      needs,
      probability: candidate.probability,
      triggers: {
        scoreAbove75: highScore,
        withinTenPercentOfSignalRequirements: withinTenPercent
      },
      channels: ['activity_feed'],
      futureChannels: ['discord', 'email', 'mobile_push']
    };
    emitEvent('Opportunity', 'opportunity_alert', message, payload, 'warn');
    alerts.push(payload);
  }
  return alerts;
}

async function persistCandidateHistory(runId, rows, opportunityMonitor) {
  const nearMissBySymbol = new Map((opportunityMonitor?.nearMisses || []).map((row) => [row.symbol, row]));
  if (!rows.length) return;
  await collections.candidateHistory.insertMany(rows.map((row) => {
    const nearMiss = nearMissBySymbol.get(row.symbol);
    const indicators = row.indicators || {};
    const outcome = ['created_signal', 'discovery_risk'].includes(row.signal_generation_status) ? 'promoted_to_signal' : null;
    return {
      id: nanoid(),
      run_id: runId,
      market_type: 'crypto',
      exchange: row.exchange || 'coinbase',
      adapter_name: row.adapter_name || 'coinbase',
      product_id: row.product_id || row.symbol,
      symbol: row.symbol,
      price: row.price || 0,
      score: row.score || 0,
      volume: row.volume || 0,
      relative_volume: row.relative_volume ?? indicators.relativeVolume ?? 0,
      momentum_15m: row.percent_change_15m ?? indicators.percentChange15m ?? 0,
      momentum_1h: row.percent_change_1h ?? indicators.percentChange1h ?? 0,
      spread_percent: row.spread_percent || 0,
      probability: nearMiss?.probability || null,
      needs_json: JSON.stringify(nearMiss?.needs || []),
      signal_status: row.signal_status || 'NONE',
      signal_generation_status: row.signal_generation_status || null,
      was_near_miss: nearMiss ? 1 : 0,
      outcome,
      created_at: nowIso()
    };
  }));
}

const toMs = (value) => {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
};

const secondsBetween = (from, to) => {
  const start = toMs(from);
  const end = toMs(to);
  return start && end ? Math.max(0, Math.round((end - start) / 1000)) : null;
};

const delta = (latest, previous, key) => Number((Number(latest?.[key] || 0) - Number(previous?.[key] || 0)).toFixed(2));

function parseNeeds(value) {
  try {
    return JSON.parse(value || '[]');
  } catch {
    return [];
  }
}

export async function nearMissAnalytics({ limit = 18 } = {}) {
  const rows = withoutMongoIds((await collections.candidateHistory.find({ market_type: 'crypto' }).sort({ created_at: -1 }).limit(2000).toArray())
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || ''))));
  const signals = withoutMongoIds(await collections.signals.find({ market_type: 'crypto' }, { projection: { id: 1, symbol: 1, status: 1, created_at: 1, resolved_at: 1, expired_at: 1 } }).sort({ created_at: 1 }).toArray());
  const orders = withoutMongoIds(await collections.orders.find({ market_type: 'crypto' }, { projection: { signal_id: 1, symbol: 1, status: 1, created_at: 1 } }).sort({ created_at: 1 }).toArray());
  const grouped = rows.reduce((acc, row) => {
    if (!acc.has(row.symbol)) acc.set(row.symbol, []);
    acc.get(row.symbol).push(row);
    return acc;
  }, new Map());
  const expiryMs = Math.max(config.signalTtlSeconds * 1000, 15 * 60 * 1000);
  const now = Date.now();

  const history = [...grouped.entries()].map(([symbol, snapshots]) => {
    const nearMissSnapshots = snapshots.filter((row) => Number(row.was_near_miss || 0) === 1);
    if (!nearMissSnapshots.length) return null;
    const first = nearMissSnapshots[0];
    const latest = snapshots.at(-1);
    const previous = snapshots.length > 1 ? snapshots.at(-2) : first;
    const signal = signals.find((row) => row.symbol === symbol && toMs(row.created_at) >= toMs(first.created_at));
    const signalIds = signals.filter((row) => row.symbol === symbol && toMs(row.created_at) >= toMs(first.created_at)).map((row) => row.id);
    const trade = orders.find((row) => (
      row.symbol === symbol
      && toMs(row.created_at) >= toMs(first.created_at)
      && (!row.signal_id || signalIds.includes(row.signal_id))
    ));
    const scoreDelta = delta(latest, previous, 'score');
    const scoreFromFirst = delta(latest, first, 'score');
    const volumeDelta = delta(latest, previous, 'relative_volume');
    const momentumDelta = delta(latest, previous, 'momentum_15m');
    const lastSeenMs = toMs(latest.created_at);
    const staleExpired = !signal && lastSeenMs && now - lastSeenMs > expiryMs;
    const regressed = !signal && (Number(latest.was_near_miss || 0) !== 1 || scoreFromFirst <= -2 || momentumDelta <= -0.15 || volumeDelta <= -0.25);
    let outcome = 'observed';
    if (trade || signal?.status === 'approved') outcome = 'promoted_to_trade';
    else if (signal && signal.status !== 'expired') outcome = 'promoted_to_signal';
    else if (signal?.status === 'expired' || staleExpired) outcome = 'expired';
    else if (regressed) outcome = 'regressed';

    const failureTime = outcome === 'expired'
      ? (signal?.expired_at || signal?.resolved_at || (staleExpired ? new Date(toMs(first.created_at) + expiryMs).toISOString() : latest.created_at))
      : outcome === 'regressed'
        ? latest.created_at
        : null;

    return {
      symbol,
      outcome,
      firstSeenAt: first.created_at,
      lastSeenAt: latest.created_at,
      observations: snapshots.length,
      score: {
        first: Number(first.score || 0),
        previous: Number(previous.score || 0),
        latest: Number(latest.score || 0),
        delta: scoreDelta,
        fromFirst: scoreFromFirst
      },
      volume: {
        first: Number(first.relative_volume || 0),
        previous: Number(previous.relative_volume || 0),
        latest: Number(latest.relative_volume || 0),
        delta: volumeDelta,
        usd: Number(latest.volume || 0)
      },
      momentum: {
        first15m: Number(first.momentum_15m || 0),
        previous15m: Number(previous.momentum_15m || 0),
        latest15m: Number(latest.momentum_15m || 0),
        delta15m: momentumDelta,
        latest1h: Number(latest.momentum_1h || 0)
      },
      probability: latest.probability || first.probability || 'WATCH',
      needs: parseNeeds(latest.needs_json || first.needs_json),
      timeUntilSignalSeconds: signal ? secondsBetween(first.created_at, signal.created_at) : null,
      timeUntilFailureSeconds: failureTime ? secondsBetween(first.created_at, failureTime) : null
    };
  }).filter(Boolean);

  const isRising = (row) => row.outcome === 'observed' && (row.score.delta > 0 || row.volume.delta > 0 || row.momentum.delta15m > 0);
  const isFalling = (row) => ['expired', 'regressed'].includes(row.outcome) || row.score.delta < 0 || row.volume.delta < 0 || row.momentum.delta15m < 0;
  const outcomeCounts = history.reduce((acc, row) => ({ ...acc, [row.outcome]: (acc[row.outcome] || 0) + 1 }), {});

  return {
    risingCandidates: history.filter(isRising).sort((a, b) => (b.score.delta + b.volume.delta + b.momentum.delta15m) - (a.score.delta + a.volume.delta + a.momentum.delta15m)).slice(0, limit),
    fallingCandidates: history.filter(isFalling).sort((a, b) => (a.score.delta + a.volume.delta + a.momentum.delta15m) - (b.score.delta + b.volume.delta + b.momentum.delta15m)).slice(0, limit),
    history: history.sort((a, b) => toMs(b.lastSeenAt) - toMs(a.lastSeenAt)).slice(0, limit * 2),
    outcomeCounts,
    generatedAt: new Date().toISOString()
  };
}

export async function cryptoMarketRegime() {
  const rows = await Promise.all(cryptoMajors.map(async (symbol) => {
    const candles = await coinbaseCryptoAdapter.getCandles(symbol, '5m');
    const closes = candles.map((row) => row.close);
    const latest = closes.at(-1) || 0;
    const rowVwap = vwap(candles);
    return { symbol, price: latest, vwap: rowVwap, ema9: ema(closes, 9), ema20: ema(closes, 20) };
  }));
  const btc = rows.find((row) => row.symbol === 'BTC-USD');
  const eth = rows.find((row) => row.symbol === 'ETH-USD');
  const bullish = [btc, eth].every((row) => row && row.price > row.vwap && row.ema9 > row.ema20);
  const bearish = [btc, eth].every((row) => row && row.price < row.vwap && row.ema9 < row.ema20);
  const regime = bullish ? 'BULLISH' : bearish ? 'BEARISH' : 'NEUTRAL';
  await collections.marketRegime.insertOne({
    id: nanoid(),
    regime,
    spy_status: btc?.symbol || 'BTC-USD',
    qqq_status: eth?.symbol || 'ETH-USD',
    details_json: JSON.stringify({ market_type: 'crypto', exchange: 'coinbase', rows }),
    created_at: nowIso()
  });
  return { regime, context: rows };
}

async function scoreCryptoSymbol(symbol, settings, blocked, productMap = new Map()) {
  const product = productMap.get(symbol);
  const ticker = await coinbaseCryptoAdapter.getTicker(symbol).catch((error) => {
    const wrapped = new Error(`missing quote data: ${error.message}`);
    wrapped.gate = 'missing_quote_data';
    throw wrapped;
  });
  const candles = await coinbaseCryptoAdapter.getCandles(symbol, '5m').catch((error) => {
    const wrapped = new Error(`missing candle data: ${error.message}`);
    wrapped.gate = 'missing_candle_data';
    throw wrapped;
  });
  const closes = candles.map((row) => row.close);
  const volumes = candles.map((row) => row.volume);
  const latest = Number(ticker.price || closes.at(-1) || 0);
  const fetchedAt = Date.now();
  const sourceTime = quoteTimestamp(ticker);
  const quoteFresh = Boolean(latest) && fetchedAt - sourceTime <= maxQuoteAgeMs;
  const latestVolume = Number(volumes.at(-1) || 0);
  const avgVolume = volumes.slice(-30).reduce((sum, value) => sum + value, 0) / Math.max(1, Math.min(30, volumes.length));
  const indicators = {
    ema9: ema(closes, 9),
    ema20: ema(closes, 20),
    vwap: vwap(candles),
    rsi14: rsi(closes, 14),
    percentChange15m: percentChange(closes, 3),
    percentChange1h: percentChange(closes, 12),
    relativeVolume: avgVolume ? latestVolume / avgVolume : 0,
    avgVolume,
    volume_avg: avgVolume,
    volatility: closes.length ? Math.max(...closes.slice(-20)) - Math.min(...closes.slice(-20)) : 0
  };
  const reasons = [];
  const checks = [];
  const add = (key, pass, reason) => {
    checks.push({ key, pass, reason });
    if (!pass) reasons.push(reason);
  };
  add('priceMin', latest >= settings.minPrice, `price below ${settings.minPrice}`);
  add('priceMax', latest <= settings.maxPrice, `price above ${settings.maxPrice}`);
  add('volume', Number(ticker.volume24h || 0) >= settings.min24hVolumeUsd, `24h volume below ${settings.min24hVolumeUsd}`);
  add('relativeVolume', indicators.relativeVolume >= settings.minRelativeVolume, `relative volume below ${settings.minRelativeVolume}`);
  add('change15m', indicators.percentChange15m >= settings.minPercentChange15m, `15m change below ${settings.minPercentChange15m}%`);
  add('change1h', indicators.percentChange1h >= settings.minPercentChange1h, `1h change below ${settings.minPercentChange1h}%`);
  add('spread', Number(ticker.spreadPercent || 0) <= settings.maxSpreadPercent, `spread above ${settings.maxSpreadPercent}%`);
  add('candles', candles.length >= settings.minCandleCount, `candle count below ${settings.minCandleCount}`);
  add('stable', !(settings.excludeStablecoins && stable.has(symbol)), 'stablecoin excluded');
  add('blocked', !blocked.has(symbol), 'symbol blocked');
  add('price', latest > 0, 'missing price');
  add('quoteFresh', quoteFresh, 'stale quote');
  add('tradable', isProductTradable(product), 'product not tradable');
  const trendScore = latest > indicators.vwap && indicators.ema9 > indicators.ema20 ? 30 : 5;
  const momentumScore = Math.max(0, Math.min(30, indicators.percentChange15m * 25 + indicators.percentChange1h * 10));
  const liquidityScore = Math.min(25, Number(ticker.volume24h || 0) / 5000000);
  const spreadScore = Math.max(0, 15 - Number(ticker.spreadPercent || 0) * 20);
  const score = trendScore + momentumScore + liquidityScore + spreadScore;
  return {
    id: nanoid(),
    symbol,
    product_id: symbol,
    market_type: 'crypto',
    exchange: 'coinbase',
    price: latest,
    quote_fetched_at: new Date(fetchedAt).toISOString(),
    quote_source_time: new Date(sourceTime).toISOString(),
    quote_fresh: quoteFresh,
    volume: Number(ticker.volume24h || 0),
    spread_percent: ticker.spreadPercent,
    relative_volume: indicators.relativeVolume,
    percent_change_15m: indicators.percentChange15m,
    percent_change_1h: indicators.percentChange1h,
    indicators,
    candles,
    candle_count: candles.length,
    product,
    tradable: isProductTradable(product),
    blocked: blocked.has(symbol),
    error_gate: null,
    score: Number(score.toFixed(2)),
    passed: reasons.length === 0,
    reason: reasons.length ? reasons.join('; ') : 'passed crypto scanner filters',
    passed_filters: checks.filter((row) => row.pass).length,
    total_filters: checks.length,
    blockers: checks.filter((row) => !row.pass).slice(0, 2).map((row) => row.reason)
  };
}

function recommendationForGate(gate, settings) {
  const recommendations = {
    scanner_passed: 'Relax scanner filters only if liquidity and spread safety remain acceptable.',
    spread: `Raise max signal spread slightly above ${settings.maxSignalSpreadPercent}, or wait for tighter order books.`,
    regime: 'Switch to discovery mode or wait for crypto regime to turn neutral or bullish.',
    vwap: 'Use balanced mode to make VWAP preferred instead of mandatory.',
    ema: 'Wait for EMA9 to reclaim EMA20, or keep this as a watchlist candidate.',
    momentum: 'Use discovery mode or wait for positive 15m momentum.',
    rsi: `Widen RSI bounds from ${settings.rsiMin}-${settings.rsiMax} only if the setup still has controlled risk.`,
    score: `Lower minimum signal score below ${settings.minSignalScore}, or use balanced/discovery mode.`,
    duplicate: 'Review the existing pending signal instead of creating another one.',
    already_in_position: 'Manage the existing open position instead of creating another entry signal.',
    blocked_symbol: 'Unblock the symbol only after intentionally allowing it back into the crypto universe.',
    product_tradable: 'Use only active, tradable Coinbase USD products.',
    missing_quote_data: 'Wait for Coinbase ticker/order book data to refresh.',
    missing_candle_data: 'Wait for enough Coinbase candle history before creating a signal.',
    quote_fresh: 'Wait for a fresh Coinbase quote.',
    kill_switch: 'Reset the kill switch before allowing new entry signals.',
    max_daily_loss: 'Daily loss guard is active; wait until the next session.',
    volume_24h: 'Use a more liquid Coinbase product or lower scanner volume only with caution.'
  };
  return recommendations[gate] || 'Review the failed gate before loosening signal settings.';
}

export function evaluateCryptoSignalGate(row, regime, settings = cryptoStrategySettings(), safety = {}) {
  const i = row.indicators || {};
  const signalMode = settings.signalMode || 'strict';
  const regimeName = regime?.regime || 'NEUTRAL';
  const spreadPercent = Number(row.spread_percent || 0);
  const rsiValue = Number(i.rsi14 || 0);
  const candleCount = Number(row.candle_count || row.indicators?.candleCount || 0);
  const price = Number(row.price || 0);
  const isBlocked = Boolean(row.blocked || safety.blockedSymbols?.has?.(row.symbol));
  const duplicatePending = Boolean(safety.pendingSignalSymbols?.has?.(row.symbol));
  const alreadyInPosition = Boolean(safety.openPositionSymbols?.has?.(row.symbol));
  const min24hVolumeUsd = Number(settings.min24hVolumeUsd || 0);
  const checklist = {
    scannerPassed: Boolean(row.passed),
    vwap: price > Number(i.vwap || 0),
    ema: Number(i.ema9 || 0) > Number(i.ema20 || 0),
    momentum: Number(i.percentChange15m || row.percent_change_15m || 0) > 0,
    rsi: rsiValue >= Number(settings.rsiMin) && rsiValue <= Number(settings.rsiMax),
    spread: spreadPercent <= Number(settings.maxSignalSpreadPercent),
    regime: ['BULLISH', 'NEUTRAL'].includes(regimeName) || Boolean(settings.allowCounterRegimeTrades) || signalMode === 'discovery',
    score: Number(row.score || 0) >= Number(settings.minSignalScore),
    productTradable: Boolean(row.tradable),
    blocked: !isBlocked,
    freshPrice: price > 0 && row.quote_fresh !== false,
    candles: candleCount > 0,
    volume24h: min24hVolumeUsd ? Number(row.volume || 0) >= min24hVolumeUsd : true,
    killSwitch: !safety.killSwitchActive,
    maxDailyLoss: !safety.maxDailyLossHit,
    duplicatePending: !duplicatePending,
    alreadyInPosition: !alreadyInPosition
  };
  const failedGates = [];
  const fail = (key, label) => failedGates.push({ key, label, recommendedAdjustment: recommendationForGate(key, settings) });

  if (row.error_gate) fail(row.error_gate, row.reason || row.error_gate);
  if (!checklist.scannerPassed) fail('scanner_passed', row.reason || 'scanner filters failed');
  if (!checklist.productTradable) fail('product_tradable', 'product not tradable');
  if (!checklist.blocked) fail('blocked_symbol', 'symbol blocked');
  if (!checklist.freshPrice) fail(price > 0 ? 'quote_fresh' : 'missing_quote_data', price > 0 ? 'stale quote' : 'missing price');
  if (!checklist.candles) fail('missing_candle_data', 'missing candle data');
  if (!checklist.volume24h) fail('volume_24h', `24h volume below ${min24hVolumeUsd}`);
  if (!checklist.killSwitch) fail('kill_switch', 'kill switch active');
  if (!checklist.maxDailyLoss) fail('max_daily_loss', 'max daily loss hit');
  if (!checklist.duplicatePending) fail('duplicate', 'pending crypto signal already exists for this symbol');
  if (!checklist.alreadyInPosition) fail('already_in_position', 'already in open position');
  if (!checklist.spread) fail('spread', `spread ${spreadPercent.toFixed(2)}% above signal max ${settings.maxSignalSpreadPercent}%`);
  if (!checklist.regime) fail('regime', `crypto regime ${regimeName} blocks long entries`);
  if ((settings.requirePriceAboveVwap || signalMode === 'discovery') && !checklist.vwap) fail('vwap', 'price not above VWAP');
  if ((settings.requireEma9AboveEma20 || signalMode === 'discovery') && !checklist.ema) fail('ema', 'EMA9 not above EMA20');
  if ((settings.requirePositive15mMomentum || signalMode === 'discovery') && !checklist.momentum) fail('momentum', '15m momentum not positive');
  if (!checklist.rsi) fail('rsi', `RSI ${rsiValue.toFixed(1)} outside ${settings.rsiMin}-${settings.rsiMax}`);
  if (!checklist.score) fail('score', `score ${Number(row.score || 0).toFixed(1)} below ${settings.minSignalScore}`);

  const discoveryWarningGates = new Set(['regime', 'vwap', 'ema', 'momentum']);
  const hardFailures = failedGates.filter((gate) => !(signalMode === 'discovery' && discoveryWarningGates.has(gate.key)));
  if (!settings.enableLegacyCryptoStrategy) {
    hardFailures.push({ key: 'legacy_disabled', label: 'Legacy diagnostic only: disabled because historical outcomes showed 22/22 would-have-lost signals.', recommendedAdjustment: 'Use Strategy V2 instead of enabling legacy signal creation.' });
  }
  const wouldCreateSignal = settings.enableLegacyCryptoStrategy && hardFailures.length === 0;
  let status = signalMode === 'discovery' ? 'discovery_risk' : 'created_signal';
  if (!wouldCreateSignal) {
    if (failedGates.some((gate) => gate.key === 'duplicate')) status = 'duplicate_pending_signal';
    else if (failedGates.some((gate) => gate.key === 'already_in_position')) status = 'already_in_position';
    else if (failedGates.some((gate) => gate.key === 'product_tradable' || gate.key === 'blocked_symbol')) status = 'unsafe_product';
    else if (failedGates.some((gate) => gate.key === 'missing_quote_data' || gate.key === 'quote_fresh')) status = 'missing_quote_data';
    else if (failedGates.some((gate) => gate.key === 'missing_candle_data')) status = 'missing_candle_data';
    else if (hardFailures.some((gate) => gate.key === 'legacy_disabled')) status = 'legacy_strategy_disabled';
    else if (failedGates.some((gate) => gate.key === 'regime')) status = 'blocked_by_regime';
    else if (failedGates.some((gate) => gate.key === 'scanner_passed')) status = 'rejected_filters';
    else status = 'no_buy_confirmation';
  }
  const reason = wouldCreateSignal
    ? signalMode === 'discovery'
      ? 'discovery signal can be created with manual review warning'
      : 'pending crypto BUY signal can be created'
    : hardFailures.map((gate) => gate.label).join('; ');
  const firstFailure = hardFailures[0] || failedGates[0];

  return {
    legacy_diagnostic_only: !settings.enableLegacyCryptoStrategy,
    checklist,
    failedGates,
    activeSettings: settings,
    signalMode,
    wouldCreateSignal,
    status,
    reason,
    recommendedAdjustment: firstFailure ? firstFailure.recommendedAdjustment : 'No adjustment needed.'
  };
}

async function saveCryptoSignal(row, regime, strategySettings, safety, learningRows = []) {
  const legacyGate = evaluateCryptoSignalGate(row, regime, strategySettings, safety);
  const v2Gate = evaluateCryptoStrategyV2(row, regime, safety, learningRows, strategySettings);
  emitEvent('Scanner', 'v2_gate_evaluated', `${row.symbol} V2 gate evaluated: ${v2Gate.decision}.`, { symbol: row.symbol, decision: v2Gate.decision, reason: v2Gate.block_reason, score: v2Gate.calibrated_signal_quality_score });
  if (v2Gate.confidence_cap_reason) {
    emitEvent('Scanner', 'confidence_capped', `${row.symbol} confidence capped: ${v2Gate.confidence_cap_reason}`, { symbol: row.symbol, reason: v2Gate.confidence_cap_reason, cap: v2Gate.confidence_cap }, 'warn');
  }
  if (v2Gate.failedGates?.some((gate) => gate.key === 'bearish_regime')) {
    emitEvent('Scanner', 'bearish_long_blocked', `${row.symbol} long blocked: bearish regime historically unprofitable.`, { symbol: row.symbol, regime: regime?.regime }, 'warn');
  }
  if (!v2Gate.wouldCreateSignal) {
    emitEvent('Scanner', 'v2_candidate_blocked', `${row.symbol} V2 blocked: ${v2Gate.block_reason || 'conditions are not proven'}`, { symbol: row.symbol, reason: v2Gate.block_reason, failedGates: v2Gate.failedGates }, 'info');
    return { ...v2Gate, legacy_gate: legacyGate, reason: v2Gate.block_reason || 'No trade. Conditions are not proven.' };
  }
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const existing = await collections.signals.findOne({ symbol: row.symbol, status: 'pending', market_type: 'crypto', created_at: { $gte: cutoff } });
  if (existing) {
    const duplicateGate = { key: 'duplicate', label: 'pending crypto signal already exists for this symbol' };
    return { ...v2Gate, legacy_gate: legacyGate, failedGates: [...(v2Gate.failedGates || []), duplicateGate], wouldCreateSignal: false, status: 'duplicate_pending_signal', decision: 'blocked', block_reason: duplicateGate.label, reason: duplicateGate.label };
  }
  await collections.signals.insertOne({
    id: nanoid(),
    symbol: row.symbol,
    direction: 'BUY',
    entry_price: row.price,
    stop_loss: v2Gate.metrics.stop_loss,
    take_profit: v2Gate.metrics.take_profit,
    confidence: v2Gate.calibrated_signal_quality_score,
    calibrated_signal_quality_score: v2Gate.calibrated_signal_quality_score,
    confidence_cap_reason: v2Gate.confidence_cap_reason,
    reason: 'Strategy V2 pullback continuation: bullish regime, controlled pullback, reclaim, volume, and risk/reward gates passed.',
    status: 'pending',
    strategy: V2_STRATEGY_NAME,
    strategy_name: V2_STRATEGY_NAME,
    setup_type: V2_SETUP_TYPE,
    market_regime: regime?.regime || 'NEUTRAL',
    v2_metrics_json: JSON.stringify(v2Gate.metrics),
    v2_gate_json: JSON.stringify(v2Gate),
    why_valid_json: JSON.stringify(v2Gate.why_valid || []),
    why_could_fail_json: JSON.stringify(v2Gate.why_could_fail || []),
    expires_at: new Date(Date.now() + config.signalTtlSeconds * 1000).toISOString(),
    signal_price: row.price,
    stale_status: 'fresh',
    market_type: 'crypto',
    exchange: 'coinbase',
    base_asset: row.symbol.split('-')[0],
    quote_asset: 'USD',
    product_id: row.symbol,
    adapter_name: 'coinbase',
    created_at: nowIso()
  });
  emitEvent('Scanner', 'v2_signal_created', `${row.symbol} V2 pending BUY signal created; manual review required.`, { symbol: row.symbol, strategy_name: V2_STRATEGY_NAME, setup_type: V2_SETUP_TYPE, confidence: v2Gate.calibrated_signal_quality_score }, 'warn');
  return { ...v2Gate, legacy_gate: legacyGate, status: 'created_signal', reason: 'V2 pending crypto BUY signal created; manual review required' };
}

async function persistCryptoCandidate(runId, row) {
  await collections.tradingUniverseCandidates.insertOne({
    id: row.id || nanoid(),
    run_id: runId,
    market_type: 'crypto',
    exchange: 'coinbase',
    adapter_name: 'coinbase',
    product_id: row.product_id || row.symbol,
    symbol: row.symbol,
    name: row.product?.display_name || row.symbol,
    price: row.price || 0,
    percent_change: row.percent_change_15m || 0,
    volume: row.volume || 0,
    average_volume: null,
    relative_volume: row.relative_volume || 0,
    spread_percent: row.spread_percent || 0,
    tradable: row.tradable ? 1 : 0,
    fractionable: 1,
    asset_status: row.tradable ? 'active' : 'not_tradable',
    score: row.score || 0,
    passed: row.passed ? 1 : 0,
    reason: row.reason || '',
    signal_status: row.signal_status || 'NONE',
    indicators_json: JSON.stringify(row.indicators || {}),
    signal_gate_json: JSON.stringify(row.signal_gate || null),
    v2_gate_json: JSON.stringify(row.v2_gate || row.signal_gate || null),
    strategy_name: row.v2_gate?.strategy_name || null,
    setup_type: row.v2_gate?.setup_type || null,
    calibrated_signal_quality_score: row.v2_gate?.calibrated_signal_quality_score ?? null,
    confidence_cap_reason: row.v2_gate?.confidence_cap_reason || null,
    v2_block_reason: row.v2_gate?.block_reason || null,
    legacy_gate: row.legacy_gate?.legacy_diagnostic_only ? 'legacy diagnostic only' : null,
    blockers_json: JSON.stringify(row.blockers || []),
    scanned_at: nowIso()
  });
}

export async function runCryptoScanner(options = {}) {
  const settings = options.preset ? applyCryptoPreset(options.preset) : cryptoScannerSettings();
  const strategySettings = cryptoStrategySettings();
  const effectiveStrategySettings = { ...strategySettings, min24hVolumeUsd: settings.min24hVolumeUsd };
  const runId = nanoid();
  const blocked = new Set((await collections.watchlistGroups.find({ group_name: { $in: ['crypto_blocked', 'blocked'] }, enabled: 1 }).toArray()).map((row) => row.symbol));
  const productMap = await productsById().catch(() => new Map());
  const safety = { ...await cryptoSafetyContext(), blockedSymbols: blocked };
  const universe = settings.activePreset === 'crypto_conservative' ? cryptoMajors : cryptoUniverse;
  const regime = await cryptoMarketRegime();
  const learningRows = await historicalOutcomeRows().catch(() => []);
  if (!effectiveStrategySettings.enableLegacyCryptoStrategy) {
    emitEvent('Scanner', 'legacy_strategy_disabled', 'Legacy Strategy: Disabled because historical outcomes showed 22/22 would-have-lost signals.', { enableLegacyCryptoStrategy: false }, 'warn');
  }
  const rows = [];
  for (const symbol of universe) {
    try {
      rows.push(await scoreCryptoSymbol(symbol, settings, blocked, productMap));
    } catch (error) {
      rows.push({ id: nanoid(), symbol, product_id: symbol, market_type: 'crypto', exchange: 'coinbase', passed: false, reason: error.message, score: 0, price: 0, volume: 0, spread_percent: 0, relative_volume: 0, indicators: {}, candle_count: 0, tradable: false, blocked: blocked.has(symbol), error_gate: error.gate || 'missing_quote_data', passed_filters: 0, total_filters: 1, blockers: [error.message] });
    }
  }
  for (const row of rows) {
    row.run_id = runId;
    const signalGeneration = row.passed
      ? await saveCryptoSignal(row, regime, effectiveStrategySettings, safety, learningRows)
      : { ...evaluateCryptoStrategyV2(row, regime, safety, learningRows, effectiveStrategySettings), legacy_gate: evaluateCryptoSignalGate(row, regime, effectiveStrategySettings, safety) };
    row.signal_status = ['created_signal', 'discovery_risk', 'duplicate_pending_signal'].includes(signalGeneration.status) ? 'BUY' : 'NONE';
    row.signal_generation_status = signalGeneration.status;
    row.signal_generation_reason = signalGeneration.reason;
    row.signal_gate = signalGeneration;
    row.v2_gate = signalGeneration.strategy_name === V2_STRATEGY_NAME ? signalGeneration : null;
    row.legacy_gate = signalGeneration.legacy_gate || null;
    row.legacy_strategy_label = effectiveStrategySettings.enableLegacyCryptoStrategy ? 'legacy enabled' : 'legacy diagnostic only';
  }
  const passed = rows.filter((row) => row.passed).sort((a, b) => b.score - a.score).slice(0, settings.maxResults);
  const rejected = rows.filter((row) => !row.passed);
  const signalGeneration = rows.filter((row) => row.passed).reduce((acc, row) => {
    const status = row.signal_generation_status || 'unknown';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  await Promise.all(rows.map((row) => persistCryptoCandidate(runId, row)));
  const gateSummary = signalGateSummary(rows);
  const topBlocker = topBlockerFromSummary(gateSummary);
  const opportunityMonitor = signalOpportunityMonitor(rows, settings, effectiveStrategySettings);
  const opportunityAlerts = await emitOpportunityAlerts(runId, opportunityMonitor, settings, effectiveStrategySettings);
  await persistCandidateHistory(runId, rows, opportunityMonitor);
  const nearMissHistory = await nearMissAnalytics();
  await collections.scannerRuns.insertOne({
    id: runId,
    status: 'completed',
    total_scanned: rows.length,
    passed_count: passed.length,
    rejected_count: rejected.length,
    settings_json: JSON.stringify({ market_type: 'crypto', exchange: 'coinbase', settings, strategySettings: effectiveStrategySettings, gateSummary, topBlocker, opportunityMonitor, opportunityAlerts, nearMissHistory }),
    created_at: nowIso(),
    completed_at: nowIso()
  });
  emitEvent('Scanner', 'crypto_scanner_completed', `Crypto scanner completed: ${passed.length} passed, ${rejected.length} rejected.`, { runId, market_type: 'crypto' });
  return {
    runId,
    marketType: 'crypto',
    exchange: 'coinbase',
    regime,
    activeFilters: settings,
    strategySettings: effectiveStrategySettings,
    passed,
    rejected,
    signalGeneration,
    signalGateSummary: gateSummary,
    topBlocker,
    opportunityMonitor,
    opportunityAlerts,
    nearMissHistory,
    topBlockerMessage: gateSummary.createdPendingSignals === 0 ? `No signals created. Top blocker: ${topBlocker}.` : '',
    closestToPassing: [...rejected].sort((a, b) => (b.passed_filters - a.passed_filters) || (b.score - a.score)).slice(0, 10),
    rejectionReasons: summarizeRejections(rejected),
    suggestedTuning: summarizeRejections(rejected).slice(0, 4).map((row) => row.reason.includes('spread') ? 'Avoid wide spreads; raise max spread only slightly.' : row.reason.includes('volume') ? 'Try Crypto Micro Account or lower 24h volume threshold.' : row.reason.includes('change') ? 'Run Momentum Hunt during active moves.' : `Review ${row.reason}.`)
  };
}

export function cryptoScannerSettingsPayload() {
  return { settings: cryptoScannerSettings(), presets: cryptoScannerPresets, universe: cryptoUniverse, focus: cryptoMajors };
}

async function scannerRunSymbols(runId) {
  const run = runId
    ? await collections.scannerRuns.findOne({ id: runId })
    : await collections.scannerRuns.findOne(
      { status: 'completed', settings_json: { $regex: '"market_type":"crypto"' } },
      { sort: { created_at: -1 } }
    );
  const id = run?.id;
  if (!id) throw new Error('No completed crypto scanner run found.');
  const symbols = await collections.tradingUniverseCandidates.distinct('symbol', { run_id: id, market_type: 'crypto' });
  const rows = symbols.sort().map((symbol) => ({ symbol }));
  if (!rows.length) throw new Error('Scanner run has no persisted crypto candidates. Run the crypto scanner again.');
  return { runId: id, symbols: rows.map((row) => row.symbol) };
}

function strategySettingsForMode(mode, scannerSettings) {
  return {
    ...signalModePresets[normalizedSignalMode(mode)],
    signalMode: normalizedSignalMode(mode),
    min24hVolumeUsd: scannerSettings.min24hVolumeUsd
  };
}

async function scoreRealRunSymbol(symbol, scannerSettings, blocked, productMap) {
  return scoreCryptoSymbol(symbol, scannerSettings, blocked, productMap);
}

export async function debugCryptoSignal(input = {}) {
  const scannerSettings = cryptoScannerSettings();
  const strategySettings = cryptoStrategySettings();
  const blocked = new Set((await collections.watchlistGroups.find({ group_name: { $in: ['crypto_blocked', 'blocked'] }, enabled: 1 }).toArray()).map((row) => row.symbol));
  const productMap = await productsById().catch(() => new Map());
  const safety = { ...await cryptoSafetyContext(), blockedSymbols: blocked };
  const regime = await cryptoMarketRegime();
  const { runId, symbols } = await scannerRunSymbols(input.runId);
  const symbol = String(input.symbol || '').toUpperCase();
  if (!symbol || !symbols.includes(symbol)) throw new Error('Debug requires a symbol from the selected real crypto scanner run.');
  const row = await scoreRealRunSymbol(symbol, scannerSettings, blocked, productMap);
  const effectiveSettings = { ...strategySettings, min24hVolumeUsd: scannerSettings.min24hVolumeUsd };

  const gate = evaluateCryptoSignalGate(row, regime, effectiveSettings, safety);
  return {
    runId,
    symbol: row.symbol,
    candidate: row,
    regime,
    checklist: gate.checklist,
    failedGates: gate.failedGates,
    activeSettings: gate.activeSettings,
    signalMode: gate.signalMode,
    would_create_signal: gate.wouldCreateSignal,
    wouldCreateSignal: gate.wouldCreateSignal,
    reason: gate.reason,
    status: gate.status,
    recommendedAdjustment: gate.recommendedAdjustment
  };
}

export async function simulateCryptoSignalModes(input = {}) {
  const scannerSettings = cryptoScannerSettings();
  const blocked = new Set((await collections.watchlistGroups.find({ group_name: { $in: ['crypto_blocked', 'blocked'] }, enabled: 1 }).toArray()).map((row) => row.symbol));
  const productMap = await productsById().catch(() => new Map());
  const safety = { ...await cryptoSafetyContext(), blockedSymbols: blocked };
  const regime = await cryptoMarketRegime();
  const { runId, symbols } = await scannerRunSymbols(input.runId);
  const rows = [];

  for (const symbol of symbols) {
    try {
      const row = await scoreRealRunSymbol(symbol, scannerSettings, blocked, productMap);
      const strict = evaluateCryptoSignalGate(row, regime, strategySettingsForMode('strict', scannerSettings), safety);
      const balanced = evaluateCryptoSignalGate(row, regime, strategySettingsForMode('balanced', scannerSettings), safety);
      const discovery = evaluateCryptoSignalGate(row, regime, strategySettingsForMode('discovery', scannerSettings), safety);
      const topGate = [strict, balanced, discovery].flatMap((gate) => gate.failedGates)[0];
      rows.push({
        symbol,
        price: row.price,
        strict: { wouldCreate: strict.wouldCreateSignal, failedGates: strict.failedGates },
        balanced: { wouldCreate: balanced.wouldCreateSignal, failedGates: balanced.failedGates },
        discovery: { wouldCreate: discovery.wouldCreateSignal, failedGates: discovery.failedGates },
        topBlocker: topGate?.label || 'none',
        recommendation: topGate?.recommendedAdjustment || 'No adjustment needed.'
      });
    } catch (error) {
      rows.push({
        symbol,
        price: 0,
        strict: { wouldCreate: false, failedGates: [{ key: 'missing_quote_data', label: error.message }] },
        balanced: { wouldCreate: false, failedGates: [{ key: 'missing_quote_data', label: error.message }] },
        discovery: { wouldCreate: false, failedGates: [{ key: 'missing_quote_data', label: error.message }] },
        topBlocker: error.message,
        recommendation: 'Wait for Coinbase market data to refresh.'
      });
    }
  }

  return { runId, regime, rows };
}
