import { collections, nowIso, withoutMongoIds } from './db.js';
import { emitEvent } from './events.js';
import { evaluateCryptoStrategyV2 } from './cryptoStrategyV2.js';
import { confidenceCalibrationReport, learningSnapshot, regimePerformance, historicalOutcomeRows } from './strategyLearning.js';

const n = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const outcomeLabel = (row) => row.outcome || (row.target_hit_first ? 'would_have_won' : row.stop_hit_first ? 'would_have_lost' : 'unknown');
const isLoss = (row) => String(outcomeLabel(row)).includes('lost') || row.stop_hit_first || row.would_hit_stop;

function v2DecisionFromStoredSignal(row) {
  const regime = row.market_regime || row.regime || 'UNKNOWN';
  if (String(regime).toUpperCase() === 'BEARISH') {
    return {
      decision: 'blocked',
      block_reason: 'Long blocked: bearish regime historically unprofitable.',
      calibrated_signal_quality_score: Math.min(n(row.confidence), 0.55),
      failedGates: [{ key: 'bearish_regime', label: 'Long blocked: bearish regime historically unprofitable.' }]
    };
  }
  return {
    decision: 'blocked',
    block_reason: 'insufficient data: historical candles/candidate snapshot unavailable for exact V2 replay',
    calibrated_signal_quality_score: 0,
    insufficient_data: true,
    failedGates: [{ key: 'insufficient_data', label: 'insufficient data: historical candles/candidate snapshot unavailable for exact V2 replay' }]
  };
}

export async function simulateV2AgainstHistory() {
  const [rows, latestCandidates] = await Promise.all([
    historicalOutcomeRows(),
    collections.tradingUniverseCandidates.find({ market_type: 'crypto' }).sort({ scanned_at: -1 }).limit(500).toArray()
  ]);
  const candidateBySymbol = new Map(withoutMongoIds(latestCandidates).map((row) => [row.symbol, row]));
  const simulations = rows.map((row) => {
    const candidate = candidateBySymbol.get(row.symbol);
    let result;
    if (candidate?.v2_gate_json) {
      try {
        result = JSON.parse(candidate.v2_gate_json);
      } catch {
        result = null;
      }
    }
    if (!result && candidate?.indicators_json) {
      try {
        const indicators = JSON.parse(candidate.indicators_json || '{}');
        result = evaluateCryptoStrategyV2({ ...candidate, price: candidate.price || row.entry, indicators, candles: [] }, { regime: row.market_regime || 'UNKNOWN', context: [] }, {}, rows);
      } catch {
        result = null;
      }
    }
    if (!result) result = v2DecisionFromStoredSignal(row);
    return {
      signal_id: row.signal_id || row.id,
      symbol: row.symbol,
      old_confidence: n(row.confidence),
      old_outcome: outcomeLabel(row),
      regime: row.market_regime || row.regime || 'UNKNOWN',
      v2_decision: result.decision || (result.wouldCreateSignal ? 'allowed' : 'blocked'),
      v2_block_reason: result.block_reason || result.reason || null,
      v2_quality_score: result.calibrated_signal_quality_score || 0,
      insufficient_data: Boolean(result.insufficient_data),
      failed_gates: result.failedGates || []
    };
  });
  const losing = simulations.filter((row) => String(row.old_outcome).includes('lost'));
  const blockedLosers = losing.filter((row) => row.v2_decision === 'blocked').length;
  const summary = {
    oldStrategySignals: simulations.length,
    oldStrategyWouldHaveLost: losing.length,
    v2WouldHaveBlocked: simulations.filter((row) => row.v2_decision === 'blocked').length,
    v2WouldHaveAllowed: simulations.filter((row) => row.v2_decision === 'allowed').length,
    v2SafetyImprovementPercent: losing.length ? (blockedLosers / losing.length) * 100 : 0,
    insufficientData: simulations.filter((row) => row.insufficient_data).length
  };
  const blockedConditionCounts = simulations.reduce((acc, row) => {
    const reason = row.v2_block_reason || (row.insufficient_data ? 'insufficient data' : 'allowed');
    if (row.v2_decision === 'blocked') acc[reason] = (acc[reason] || 0) + 1;
    return acc;
  }, {});
  emitEvent('Strategy Lab', 'strategy_lab_simulation_completed', `V2 simulation completed: ${summary.v2WouldHaveBlocked}/${summary.oldStrategySignals} blocked.`, summary);
  return {
    summary,
    rows: simulations,
    blockedConditionCounts: Object.entries(blockedConditionCounts).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    generatedAt: nowIso()
  };
}

export async function strategyLabSummary() {
  const [snapshot, simulation] = await Promise.all([learningSnapshot(), simulateV2AgainstHistory()]);
  return { ...snapshot, v2Simulation: simulation };
}

export { confidenceCalibrationReport, regimePerformance };
