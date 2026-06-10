import { config } from './config.js';
import { getSetting, nowIso } from './db.js';
import { historicalContextFor } from './strategyLearning.js';

export const V2_STRATEGY_NAME = 'crypto_regime_pullback_continuation_v2';
export const V2_SETUP_TYPE = 'pullback_continuation';

const n = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const bool = (key, fallback) => String(getSetting(key, fallback)).toLowerCase() === 'true';
const pctDiff = (a, b) => (b ? ((n(a) - n(b)) / n(b)) * 100 : 0);
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

export function cryptoStrategyV2Settings(overrides = {}) {
  return {
    enableLegacyCryptoStrategy: bool('enable_legacy_crypto_strategy', config.enableLegacyCryptoStrategy),
    blockLongsInBearishRegime: bool('block_longs_in_bearish_regime', config.blockLongsInBearishRegime),
    allowNeutralLongs: bool('allow_neutral_longs', config.allowNeutralLongs),
    minV2SignalQuality: n(getSetting('min_v2_signal_quality', config.minV2SignalQuality), config.minV2SignalQuality),
    minV2RiskReward: n(getSetting('min_v2_risk_reward', config.minV2RiskReward), config.minV2RiskReward),
    maxDistanceFromVwapPercent: n(getSetting('max_distance_from_vwap_percent', config.maxDistanceFromVwapPercent), config.maxDistanceFromVwapPercent),
    maxDistanceFromEma20Percent: n(getSetting('max_distance_from_ema20_percent', config.maxDistanceFromEma20Percent), config.maxDistanceFromEma20Percent),
    minPullbackDepthPercent: n(getSetting('min_pullback_depth_percent', config.minPullbackDepthPercent), config.minPullbackDepthPercent),
    maxPullbackDepthPercent: n(getSetting('max_pullback_depth_percent', config.maxPullbackDepthPercent), config.maxPullbackDepthPercent),
    minReclaimStrengthPercent: n(getSetting('min_reclaim_strength_percent', config.minReclaimStrengthPercent), config.minReclaimStrengthPercent),
    minRelativeVolume: n(getSetting('min_v2_relative_volume', config.cryptoScanner.minRelativeVolume), config.cryptoScanner.minRelativeVolume),
    min15mMomentum: n(getSetting('min_15m_momentum', config.min15mMomentum), config.min15mMomentum),
    min1hMomentum: n(getSetting('min_1h_momentum', config.min1hMomentum), config.min1hMomentum),
    maxRsi: 75,
    minStopDistancePercent: 0.25,
    maxStopDistancePercent: 4.0,
    maxCandleExtensionPercent: 1.0,
    ...overrides
  };
}

function latestRegimeRow(regime, symbol) {
  return (regime?.context || []).find((row) => row.symbol === symbol) || {};
}

function pullbackMetrics(row, settings) {
  const candles = row.candles || [];
  const latest = n(row.price);
  const i = row.indicators || {};
  const lookback = candles.slice(-8);
  if (lookback.length < 5) return { sufficient: false, reason: 'insufficient candle data for pullback analysis' };
  const previous = lookback.slice(0, -1);
  const pullbackLow = Math.min(...previous.map((c) => n(c.low ?? c.close, Infinity)));
  const prePullbackHigh = Math.max(...previous.map((c) => n(c.high ?? c.close)));
  const current = lookback.at(-1) || {};
  const previousHigh = Math.max(...previous.slice(-3).map((c) => n(c.high ?? c.close)));
  const pullbackDepthPercent = prePullbackHigh ? ((prePullbackHigh - pullbackLow) / prePullbackHigh) * 100 : 0;
  const reclaimStrengthPercent = previousHigh ? ((latest - previousHigh) / previousHigh) * 100 : 0;
  const avgVolume = n(i.avgVolume ?? i.volume_avg ?? i.averageVolume);
  const reclaimCandleVolumeRatio = avgVolume ? n(current.volume) / avgVolume : n(i.relativeVolume ?? row.relative_volume);
  return {
    sufficient: true,
    pullback_depth_percent: pullbackDepthPercent,
    pullback_low_vs_vwap_percent: pctDiff(pullbackLow, i.vwap),
    pullback_low_vs_ema20_percent: pctDiff(pullbackLow, i.ema20),
    reclaim_strength_percent: reclaimStrengthPercent,
    reclaim_candle_volume_ratio: reclaimCandleVolumeRatio,
    heldVwapOrEma20: pullbackLow >= Math.min(n(i.vwap), n(i.ema20)) * 0.992,
    reclaimedShortTermHigh: latest > previousHigh,
    reasonableDepth: pullbackDepthPercent >= settings.minPullbackDepthPercent && pullbackDepthPercent <= settings.maxPullbackDepthPercent
  };
}

function riskMetrics(row, settings) {
  const price = n(row.price);
  const i = row.indicators || {};
  const candles = row.candles || [];
  const recentLow = candles.length ? Math.min(...candles.slice(-8).map((c) => n(c.low ?? c.close, price))) : price * (1 - config.cryptoStopLossPercent / 100);
  const volatility = n(i.volatility);
  const structureStop = Math.min(price * (1 - config.cryptoStopLossPercent / 100), recentLow * 0.997);
  const target = Math.max(price * (1 + config.cryptoTakeProfitPercent / 100), price + Math.max(volatility * 0.6, price * 0.01));
  const stopDistancePercent = price ? ((price - structureStop) / price) * 100 : 0;
  const rewardRisk = price > structureStop ? (target - price) / (price - structureStop) : 0;
  return { stopLoss: structureStop, takeProfit: target, rewardRisk, stopDistancePercent };
}

function confidenceCap(rawScore, history, regimeName, symbol) {
  let cap = 0.89;
  const reasons = [];
  if (history.all.signalCount > 0 && history.allWins === 0) {
    cap = Math.min(cap, 0.65);
    reasons.push('Capped: insufficient winning history.');
  }
  if (history.strategySampleSize < 30) {
    cap = Math.min(cap, 0.75);
    reasons.push('Capped: strategy sample size too small.');
  }
  if (history.regimeSampleSize > 0 && history.regime.winRate === 0) {
    cap = Math.min(cap, 0.55);
    reasons.push(`Capped: ${String(regimeName).toLowerCase()} regime historical win rate is 0%.`);
  }
  if (history.symbolSampleSize >= 5 && history.symbol.winRate === 0) {
    cap = Math.min(cap, 0.60);
    reasons.push(`Capped: ${symbol} historical win rate is 0%.`);
  }
  return { score: Math.min(rawScore, cap), cap, reason: reasons[0] || null, reasons };
}

export function evaluateCryptoStrategyV2(row, regime, safety = {}, learningRows = [], settingOverrides = {}) {
  const settings = cryptoStrategyV2Settings(settingOverrides);
  const i = row.indicators || {};
  const regimeName = regime?.regime || row.market_regime || 'NEUTRAL';
  const btc = latestRegimeRow(regime, 'BTC-USD');
  const eth = latestRegimeRow(regime, 'ETH-USD');
  const price = n(row.price);
  const distanceFromVwap = pctDiff(price, i.vwap);
  const distanceFromEma20 = pctDiff(price, i.ema20);
  const candle = (row.candles || []).at?.(-1) || {};
  const candleExtension = n(candle.open) ? Math.abs(pctDiff(price, candle.open)) : 0;
  const recent = row.candles?.slice?.(-20) || [];
  const recentLow = recent.length ? Math.min(...recent.map((c) => n(c.low ?? c.close, price))) : price;
  const recentHigh = recent.length ? Math.max(...recent.map((c) => n(c.high ?? c.close, price))) : price;
  const recentRangePosition = recentHigh > recentLow ? (price - recentLow) / (recentHigh - recentLow) : 0.5;
  const pullback = pullbackMetrics(row, settings);
  const risk = riskMetrics(row, settings);
  const history = historicalContextFor({ rows: learningRows, symbol: row.symbol, strategy: V2_STRATEGY_NAME, regime: regimeName });
  const failedGates = [];
  const fail = (key, label) => failedGates.push({ key, label });

  const marketContext = {
    bullishRegime: regimeName === 'BULLISH',
    btcAboveVwap: n(btc.price) > n(btc.vwap),
    ethAboveVwap: n(eth.price) > n(eth.vwap),
    btcEma9AboveEma20: n(btc.ema9) > n(btc.ema20),
    ethEma9AboveEma20: n(eth.ema9) > n(eth.ema20)
  };
  if (settings.blockLongsInBearishRegime && regimeName === 'BEARISH') fail('bearish_regime', 'Long blocked: bearish regime historically unprofitable.');
  if (regimeName === 'NEUTRAL' && !settings.allowNeutralLongs) fail('neutral_regime', 'Long blocked: neutral regime is disabled by default.');
  if (!marketContext.bullishRegime && !(regimeName === 'NEUTRAL' && settings.allowNeutralLongs)) fail('market_context', `crypto regime ${regimeName} is not allowed for V2 longs`);

  if (!(price > n(i.vwap))) fail('symbol_vwap', 'symbol price is not above VWAP');
  if (!(n(i.ema9) > n(i.ema20))) fail('symbol_ema', 'symbol EMA9 is not above EMA20');
  const emaSpread = pctDiff(i.ema9, i.ema20);
  if (!(emaSpread > 0 && emaSpread <= 3)) fail('ema_spread', 'EMA spread is not positive and controlled');
  if (n(i.percentChange1h ?? row.percent_change_1h) < settings.min1hMomentum) fail('momentum_1h', `1h momentum below ${settings.min1hMomentum}%`);
  if (n(i.percentChange15m ?? row.percent_change_15m) < settings.min15mMomentum) fail('momentum_15m', `15m momentum below ${settings.min15mMomentum}%`);

  if (!pullback.sufficient) fail('no_pullback', pullback.reason);
  else {
    if (!pullback.heldVwapOrEma20) fail('pullback_hold', 'pullback did not hold VWAP/EMA20 structure');
    if (!pullback.reclaimedShortTermHigh) fail('weak_reclaim', 'current candle has not reclaimed a short-term high');
    if (!pullback.reasonableDepth) fail('pullback_depth', 'pullback depth is outside conservative range');
    if (pullback.reclaim_strength_percent < settings.minReclaimStrengthPercent) fail('weak_reclaim', `reclaim strength below ${settings.minReclaimStrengthPercent}%`);
  }

  if (n(row.relative_volume ?? i.relativeVolume) < settings.minRelativeVolume) fail('low_volume', `relative volume below ${settings.minRelativeVolume}`);
  if (n(row.volume) < n(settings.min24hVolumeUsd)) fail('low_liquidity', '24h volume below minimum liquidity threshold');
  if (pullback.sufficient && pullback.reclaim_candle_volume_ratio < settings.minRelativeVolume) fail('low_reclaim_volume', 'reclaim candle volume did not expand enough');

  if (distanceFromVwap > settings.maxDistanceFromVwapPercent) fail('overextended', 'price too far above VWAP');
  if (distanceFromEma20 > settings.maxDistanceFromEma20Percent) fail('overextended', 'price too far above EMA20');
  if (n(i.rsi14) > settings.maxRsi) fail('overextended_rsi', 'RSI above 75');
  if (candleExtension > settings.maxCandleExtensionPercent) fail('candle_extended', 'current candle already moved too much');
  if (history.strategy.signalCount >= 5 && history.strategy.averageMfe <= Math.abs(history.strategy.averageMae) * 0.5) fail('weak_mfe_history', 'MFE history for similar setups is weak');

  if (risk.rewardRisk < settings.minV2RiskReward) fail('poor_rr', `planned reward/risk below ${settings.minV2RiskReward}`);
  if (risk.stopDistancePercent < settings.minStopDistancePercent) fail('stop_too_tight', 'stop distance is too tight');
  if (risk.stopDistancePercent > settings.maxStopDistancePercent) fail('stop_too_wide', 'stop distance is too wide');
  if (n(row.spread_percent) > n(settings.maxSignalSpreadPercent ?? config.cryptoMaxSpreadPercent)) fail('spread_too_wide', 'spread too wide');
  if (row.quote_fresh === false) fail('stale_quote', 'quote is stale');
  if (!row.tradable) fail('not_tradable', 'symbol is not tradable');
  if (row.blocked || safety.blockedSymbols?.has?.(row.symbol)) fail('blocked_symbol', 'symbol blocked');
  if (safety.pendingSignalSymbols?.has?.(row.symbol)) fail('duplicate', 'pending crypto signal already exists for this symbol');
  if (safety.openPositionSymbols?.has?.(row.symbol)) fail('already_in_position', 'already in open position');
  if (safety.killSwitchActive) fail('kill_switch', 'kill switch active');
  if (safety.maxDailyLossHit) fail('max_daily_loss', 'daily loss limit hit');

  const overextensionScore = clamp((Math.max(0, distanceFromVwap) / settings.maxDistanceFromVwapPercent + Math.max(0, distanceFromEma20) / settings.maxDistanceFromEma20Percent + n(i.rsi14) / settings.maxRsi + recentRangePosition) / 4);
  const componentScores = {
    marketRegimeQuality: regimeName === 'BULLISH' ? 1 : 0,
    symbolTrendQuality: clamp((price > n(i.vwap) ? 0.35 : 0) + (n(i.ema9) > n(i.ema20) ? 0.35 : 0) + clamp(emaSpread / 1.5) * 0.30),
    pullbackQuality: pullback.sufficient ? clamp((pullback.reasonableDepth ? 0.35 : 0) + (pullback.heldVwapOrEma20 ? 0.35 : 0) + clamp(pullback.pullback_depth_percent / settings.maxPullbackDepthPercent) * 0.30) : 0,
    reclaimQuality: pullback.sufficient ? clamp((pullback.reclaimedShortTermHigh ? 0.55 : 0) + clamp(pullback.reclaim_strength_percent / Math.max(settings.minReclaimStrengthPercent * 3, 0.01)) * 0.45) : 0,
    volumeConfirmation: clamp(n(row.relative_volume ?? i.relativeVolume) / Math.max(settings.minRelativeVolume * 1.5, 1)),
    liquiditySpreadQuality: clamp((n(row.volume) / Math.max(n(settings.min24hVolumeUsd), 1)) * 0.5 + (1 - n(row.spread_percent) / Math.max(n(settings.maxSignalSpreadPercent ?? config.cryptoMaxSpreadPercent), 0.01)) * 0.5),
    riskRewardQuality: clamp(risk.rewardRisk / Math.max(settings.minV2RiskReward * 1.5, 1)),
    historicalOutcomeAdjustment: history.all.signalCount ? clamp(history.all.winRate) : 0.35
  };
  const rawScore = clamp(
    componentScores.marketRegimeQuality * 0.16
    + componentScores.symbolTrendQuality * 0.14
    + componentScores.pullbackQuality * 0.14
    + componentScores.reclaimQuality * 0.12
    + componentScores.volumeConfirmation * 0.10
    + componentScores.liquiditySpreadQuality * 0.10
    + componentScores.riskRewardQuality * 0.12
    + componentScores.historicalOutcomeAdjustment * 0.12
    - overextensionScore * 0.10
  );
  const capped = confidenceCap(rawScore, history, regimeName, row.symbol);
  if (capped.score < settings.minV2SignalQuality) fail('confidence_capped', capped.reason || `calibrated quality below ${settings.minV2SignalQuality}`);

  const metrics = {
    pullback_depth_percent: n(pullback.pullback_depth_percent),
    pullback_low_vs_vwap_percent: n(pullback.pullback_low_vs_vwap_percent),
    pullback_low_vs_ema20_percent: n(pullback.pullback_low_vs_ema20_percent),
    reclaim_strength_percent: n(pullback.reclaim_strength_percent),
    reclaim_candle_volume_ratio: n(pullback.reclaim_candle_volume_ratio),
    distance_from_vwap_percent: distanceFromVwap,
    distance_from_ema20_percent: distanceFromEma20,
    overextension_score: overextensionScore,
    candle_extension_percent: candleExtension,
    recent_range_position: recentRangePosition,
    planned_reward_risk: risk.rewardRisk,
    stop_distance_percent: risk.stopDistancePercent,
    stop_loss: risk.stopLoss,
    take_profit: risk.takeProfit
  };

  const blockedReason = failedGates[0]?.label || null;
  return {
    strategy_name: V2_STRATEGY_NAME,
    setup_type: V2_SETUP_TYPE,
    decision: failedGates.length ? 'blocked' : 'allowed',
    wouldCreateSignal: failedGates.length === 0,
    status: failedGates.length ? 'v2_candidate_blocked' : 'v2_passed',
    block_reason: blockedReason,
    failedGates,
    metrics,
    componentScores,
    calibrated_signal_quality_score: Number(capped.score.toFixed(4)),
    raw_signal_quality_score: Number(rawScore.toFixed(4)),
    confidence_cap: Number(capped.cap.toFixed(4)),
    confidence_cap_reason: capped.reason,
    confidence_cap_reasons: capped.reasons,
    why_valid: failedGates.length ? [] : ['Bullish BTC/ETH regime', 'Symbol trend aligned above VWAP/EMA20', 'Controlled pullback with reclaim', 'Volume and risk/reward gates passed'],
    why_could_fail: ['Crypto trend can reverse quickly', 'Reclaim volume may fade', 'VWAP/EMA20 hold can fail after entry', 'SignalFlow Monitor requires backend connectivity'],
    activeSettings: settings,
    evaluated_at: nowIso()
  };
}
