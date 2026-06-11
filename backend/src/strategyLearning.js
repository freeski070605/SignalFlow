import { collections, nowIso, withoutMongoIds } from './db.js';
import { emitEvent } from './events.js';

export const confidenceBuckets = [
  { key: '0.50-0.59', min: 0.50, max: 0.599999 },
  { key: '0.60-0.69', min: 0.60, max: 0.699999 },
  { key: '0.70-0.79', min: 0.70, max: 0.799999 },
  { key: '0.80-0.89', min: 0.80, max: 0.899999 },
  { key: '0.90-1.00', min: 0.90, max: 1.000001 }
];

const n = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const avg = (rows, pick) => {
  const values = rows.map(pick).map((value) => n(value, NaN)).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
};

const isWin = (row) => Boolean(row.target_hit_first || row.would_have_won || row.would_hit_target || String(row.outcome || '').includes('won')) && !row.stop_hit_first;
const isLoss = (row) => Boolean(row.stop_hit_first || row.would_have_lost || row.would_hit_stop || String(row.outcome || '').includes('lost')) && !isWin(row);
const targetHit = (row) => Boolean(row.target_hit_first || row.would_hit_target || row.would_have_won);
const stopHit = (row) => Boolean(row.stop_hit_first || row.would_hit_stop || row.would_have_lost);
const confidence = (row) => Math.max(0, Math.min(1, n(row.confidence ?? row.old_confidence ?? row.calibrated_signal_quality_score)));
const mfe = (row) => n(row.max_favorable_excursion ?? row.max_favorable_move ?? row.mfe_percent ?? row.mfe);
const mae = (row) => n(row.max_adverse_excursion ?? row.max_adverse_move ?? row.mae_percent ?? row.mae);
const strategyName = (row) => row.strategy_name || row.strategy || row.signal_strategy || 'legacy_crypto_strategy';
const setupType = (row) => row.setup_type || row.setup || 'unknown';
const regimeName = (row) => row.market_regime || row.regime || 'UNKNOWN';

function summarizeGroup(rows) {
  const wins = rows.filter(isWin).length;
  const losses = rows.filter(isLoss).length;
  const completed = wins + losses || rows.length;
  return {
    signalCount: rows.length,
    wouldHaveWonCount: wins,
    wouldHaveLostCount: losses,
    winRate: completed ? wins / completed : 0,
    averageMfe: avg(rows, mfe),
    averageMae: avg(rows, mae),
    targetHitRate: rows.length ? rows.filter(targetHit).length / rows.length : 0,
    stopHitRate: rows.length ? rows.filter(stopHit).length / rows.length : 0,
    averageOutcomeGrade: avg(rows, (row) => ({ A: 4, B: 3, C: 2, D: 1, F: 0 }[row.outcome_grade] ?? NaN)),
    averageConfidence: avg(rows, confidence),
    averagePlannedRr: avg(rows, (row) => row.planned_rr ?? row.rr_planned),
    averageActualRr: avg(rows, (row) => row.actual_rr ?? row.rr_actual)
  };
}

const by = (rows, keyFn) => rows.reduce((acc, row) => {
  const key = keyFn(row) || 'UNKNOWN';
  if (!acc.has(key)) acc.set(key, []);
  acc.get(key).push(row);
  return acc;
}, new Map());

export async function historicalOutcomeRows() {
  const [outcomes, journal] = await Promise.all([
    collections.signalOutcomes.find({ $or: [{ market_type: 'crypto' }, { market_type: { $exists: false } }, { market_type: null }] }).sort({ generated_at: -1, created_at: -1 }).limit(5000).toArray(),
    collections.tradeJournal.find({ market_type: 'crypto' }).sort({ created_at: -1 }).limit(5000).toArray()
  ]);
  return withoutMongoIds([...outcomes, ...journal]);
}

export async function regimePerformance(rows = null) {
  const data = rows || await historicalOutcomeRows();
  return [...by(data, regimeName).entries()].map(([regime, group]) => ({ regime, ...summarizeGroup(group) })).sort((a, b) => b.signalCount - a.signalCount);
}

export async function symbolPerformance(rows = null) {
  const data = rows || await historicalOutcomeRows();
  return [...by(data, (row) => row.symbol).entries()].map(([symbol, group]) => ({
    symbol,
    ...summarizeGroup(group),
    confidenceBuckets: confidenceCalibration(group).buckets
  })).sort((a, b) => b.signalCount - a.signalCount);
}

export async function strategyPerformance(rows = null) {
  const data = rows || await historicalOutcomeRows();
  return [...by(data, strategyName).entries()].map(([strategy_name, group]) => {
    const wins = group.filter(isWin).reduce((sum, row) => sum + Math.max(0, n(row.realized_pnl ?? row.pnl ?? row.actual_rr)), 0);
    const losses = Math.abs(group.filter(isLoss).reduce((sum, row) => sum + Math.min(0, n(row.realized_pnl ?? row.pnl ?? row.actual_rr)), 0));
    return { strategy_name, ...summarizeGroup(group), profitFactor: losses ? wins / losses : wins > 0 ? Infinity : 0 };
  }).sort((a, b) => b.signalCount - a.signalCount);
}

export function confidenceCalibration(rows = []) {
  const buckets = confidenceBuckets.map((bucket) => {
    const group = rows.filter((row) => confidence(row) >= bucket.min && confidence(row) <= bucket.max);
    return { bucket: bucket.key, ...summarizeGroup(group) };
  });
  const highConfidence = buckets.filter((bucket) => ['0.80-0.89', '0.90-1.00'].includes(bucket.bucket));
  const highCount = highConfidence.reduce((sum, row) => sum + row.signalCount, 0);
  const highWins = highConfidence.reduce((sum, row) => sum + row.wouldHaveWonCount, 0);
  const warning = highCount > 0 && highWins === 0
    ? 'Confidence model is not calibrated. High-confidence signals have not produced wins.'
    : null;
  return { buckets, warning, generatedAt: nowIso() };
}

export async function confidenceCalibrationReport() {
  const rows = await historicalOutcomeRows();
  const report = confidenceCalibration(rows);
  if (report.warning) {
    emitEvent('Strategy Lab', 'confidence_calibration_warning', report.warning, { highConfidenceBuckets: report.buckets.filter((row) => ['0.80-0.89', '0.90-1.00'].includes(row.bucket)) }, 'warn');
  }
  return report;
}

function conditionCounts(rows) {
  const counts = new Map();
  const add = (condition) => counts.set(condition, (counts.get(condition) || 0) + 1);
  rows.filter(isLoss).forEach((row) => {
    const regime = String(regimeName(row)).toUpperCase();
    if (regime === 'BEARISH') add('BEARISH regime');
    if (n(row.relative_volume) < 1) add('relative volume below threshold');
    if (String(row.reason || row.block_reason || '').toLowerCase().includes('vwap')) add('price below VWAP');
    if (String(row.reason || row.block_reason || '').toLowerCase().includes('pullback')) add('no pullback confirmation');
    if (n(row.max_adverse_excursion ?? row.max_adverse_move) < -1 || n(row.max_adverse_excursion ?? row.max_adverse_move) > 1) add('large adverse movement');
    if (n(row.percent_change_1h ?? row.momentum_1h) <= 0) add('weak 1h momentum');
  });
  return [...counts.entries()].map(([condition, count]) => ({ condition, count })).sort((a, b) => b.count - a.count);
}

export async function learningSnapshot() {
  const rows = await historicalOutcomeRows();
  const legacyRows = rows.filter((row) => !String(strategyName(row)).includes('crypto_regime_pullback_continuation_v2'));
  const legacy = summarizeGroup(legacyRows);
  return {
    rows,
    totalOutcomes: rows.length,
    legacyReport: {
      ...legacy,
      totalLegacySignals: legacy.signalCount,
      unprofitableWarning: legacy.signalCount > 0 && legacy.wouldHaveWonCount === 0 && legacy.wouldHaveLostCount > 0
        ? 'Legacy crypto strategy is historically unprofitable.'
        : null,
      regimeBreakdown: await regimePerformance(legacyRows)
    },
    regimePerformance: await regimePerformance(rows),
    symbolPerformance: await symbolPerformance(rows),
    strategyPerformance: await strategyPerformance(rows),
    confidenceCalibration: confidenceCalibration(rows),
    topLosingConditions: conditionCounts(rows),
    generatedAt: nowIso()
  };
}

export function historicalContextFor({ rows = [], symbol, strategy = 'crypto_regime_pullback_continuation_v2', regime = 'UNKNOWN' } = {}) {
  const allWins = rows.filter(isWin).length;
  const strategyRows = rows.filter((row) => strategyName(row) === strategy || String(strategyName(row)).includes('CRYPTO_EMA'));
  const strategyWins = strategyRows.filter(isWin).length;
  const regimeRows = rows.filter((row) => String(regimeName(row)).toUpperCase() === String(regime).toUpperCase());
  const symbolRows = rows.filter((row) => row.symbol === symbol);
  return {
    all: summarizeGroup(rows),
    allWins,
    strategy: summarizeGroup(strategyRows),
    strategyWins,
    strategySampleSize: strategyRows.length,
    regime: summarizeGroup(regimeRows),
    regimeSampleSize: regimeRows.length,
    symbol: summarizeGroup(symbolRows),
    symbolSampleSize: symbolRows.length
  };
}

export const outcomePredicates = { isWin, isLoss };
