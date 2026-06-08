import fetch from 'node-fetch';
import { nanoid } from 'nanoid';
import { db, getSetting, logEvent, setSetting } from './db.js';
import { config } from './config.js';
import { getAsset, getLatestQuote, getLatestSnapshot } from './alpaca.js';
import { emitEvent } from './events.js';

export const contextSymbols = ['SPY', 'QQQ', 'IWM', 'DIA', 'NVDA', 'AMD', 'AAPL', 'MSFT'];
export const seedUniverse = ['SOFI', 'PLTR', 'RIVN', 'LCID', 'F', 'PFE', 'NIO', 'HOOD', 'SNAP', 'INTC', 'AMD', 'TSLA', 'AAPL', 'MSFT', 'NVDA', 'MARA', 'RIOT', 'BAC', 'T', 'WBD'];

export const scannerPresets = {
  conservative: {
    minPrice: 5,
    maxPrice: 500,
    minDailyVolume: 1000000,
    minRelativeVolume: 1.2,
    maxSpreadPercent: 0.5,
    minPercentChange: 0.5
  },
  micro_account: {
    minPrice: 1,
    maxPrice: 50,
    minDailyVolume: 500000,
    minRelativeVolume: 1.0,
    maxSpreadPercent: 1.0,
    minPercentChange: 0.25
  },
  momentum_hunt: {
    minPrice: 1,
    maxPrice: 100,
    minDailyVolume: 750000,
    minRelativeVolume: 1.1,
    maxSpreadPercent: 0.75,
    minPercentChange: 1.0
  }
};

const settingKeys = {
  minPrice: 'min_price',
  maxPrice: 'max_price',
  minDailyVolume: 'min_daily_volume',
  minRelativeVolume: 'min_relative_volume',
  maxSpreadPercent: 'max_spread_percent',
  minPercentChange: 'min_percent_change',
  maxResults: 'max_results'
};

const toBool = (value, fallback = false) => {
  if (value === undefined || value === null) return fallback;
  return String(value).toLowerCase() === 'true';
};

const toNum = (key, fallback) => {
  const parsed = Number(getSetting(key, fallback));
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function scannerSettings() {
  return {
    minPrice: toNum('min_price', config.scanner.minPrice),
    maxPrice: toNum('max_price', config.scanner.maxPrice),
    minDailyVolume: toNum('min_daily_volume', config.scanner.minDailyVolume),
    minRelativeVolume: toNum('min_relative_volume', config.scanner.minRelativeVolume),
    maxSpreadPercent: toNum('max_spread_percent', config.scanner.maxSpreadPercent),
    minPercentChange: toNum('min_percent_change', config.scanner.minPercentChange),
    excludeOtc: toBool(getSetting('exclude_otc'), config.scanner.excludeOtc),
    requireActive: toBool(getSetting('require_active'), config.scanner.requireActive),
    requireTradable: toBool(getSetting('require_tradable'), config.scanner.requireTradable),
    preferFractionable: toBool(getSetting('prefer_fractionable'), config.scanner.preferFractionable),
    excludeLeveragedEtfs: toBool(getSetting('exclude_leveraged_etfs'), config.scanner.excludeLeveragedEtfs),
    maxResults: toNum('max_results', config.scanner.maxResults)
  };
}

export function saveScannerSettings(input = {}) {
  const allowed = { ...settingKeys };
  Object.entries(allowed).forEach(([publicKey, dbKey]) => {
    if (input[publicKey] !== undefined && input[publicKey] !== '') setSetting(dbKey, input[publicKey]);
  });
  setSetting('exclude_otc', 'true');
  setSetting('require_active', 'true');
  setSetting('require_tradable', 'true');
  if (input.activeScannerPreset) setSetting('active_scanner_preset', input.activeScannerPreset);
  return scannerSettings();
}

export function scannerSettingsPayload() {
  return {
    settings: scannerSettings(),
    presets: scannerPresets,
    safety: {
      excludeOtc: true,
      requireActive: true,
      requireTradable: true,
      manualApprovalRequired: true,
      autoExecutionChanged: false
    }
  };
}

export function applyScannerPreset(name) {
  const preset = scannerPresets[name];
  if (!preset) throw new Error(`Unknown scanner preset: ${name}`);
  return saveScannerSettings({ ...preset, activeScannerPreset: name });
}

export function relaxScannerSettings() {
  const current = scannerSettings();
  return saveScannerSettings({
    minPrice: Math.max(1, Number(current.minPrice || 1) * 0.8),
    maxPrice: Number(current.maxPrice || 500),
    minDailyVolume: Math.max(100000, Number(current.minDailyVolume || 0) * 0.75),
    minRelativeVolume: Math.max(0.8, Number(current.minRelativeVolume || 1) - 0.1),
    maxSpreadPercent: Math.min(2, Number(current.maxSpreadPercent || 0.5) + 0.25),
    minPercentChange: Math.max(0, Number(current.minPercentChange || 0.5) - 0.25),
    maxResults: current.maxResults
  });
}

function fallbackBars(symbol) {
  const seed = symbol.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  let price = 10 + (seed % 90);
  return Array.from({ length: 60 }, (_, index) => {
    const drift = Math.sin((index + seed) / 5) * 0.25;
    price = Math.max(1, price + drift);
    return {
      timestamp: new Date(Date.now() - (60 - index) * 300000).toISOString(),
      open: price - 0.1,
      high: price + 0.2,
      low: price - 0.3,
      close: price,
      volume: 100000 + index * 1000 + seed
    };
  });
}

async function analyze(symbol, bars) {
  const response = await fetch(`${config.quantServiceUrl}/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbol, bars })
  });
  if (!response.ok) throw new Error(`Quant service returned ${response.status}`);
  return response.json();
}

function trendFrom(result) {
  const price = Number(result.market?.price || 0);
  const vwap = Number(result.indicators?.vwap || 0);
  const ema9 = Number(result.indicators?.ema9 || 0);
  const ema20 = Number(result.indicators?.ema20 || 0);
  if (price > vwap && ema9 > ema20) return 'BULLISH';
  if (price < vwap && ema9 < ema20) return 'BEARISH';
  return 'NEUTRAL';
}

function chartFrom(bars) {
  return bars.slice(-60).map((bar) => ({
    time: Math.floor(new Date(bar.timestamp).getTime() / 1000),
    value: Number(bar.close)
  }));
}

async function marketRow(symbol) {
  const bars = await getLatestSnapshot(symbol) || fallbackBars(symbol);
  const result = await analyze(symbol, bars);
  const quote = await getLatestQuote(symbol).catch(() => null);
  const dailyVolume = bars.reduce((sum, bar) => sum + Number(bar.volume || 0), 0);
  return {
    symbol,
    data_source: 'alpaca',
    ...result.market,
    daily_volume: dailyVolume,
    indicators: result.indicators,
    trend: trendFrom(result),
    context_status: contextSymbols.includes(symbol) ? 'CONTEXT' : 'CANDIDATE',
    spread_percent: quote?.spreadPercent || 0,
    signal: result.signal,
    chart: chartFrom(bars),
    bars
  };
}

export async function safeMarketRow(symbol) {
  try {
    return await marketRow(symbol);
  } catch (error) {
    const bars = fallbackBars(symbol);
    logEvent('error', 'watchlist_scan_error', { symbol, message: error.message });
    return {
      symbol,
      data_source: 'fallback',
      data_error: error.message,
      price: bars.at(-1).close,
      change_percent: 0,
      volume: bars.at(-1).volume,
      indicators: {},
      trend: 'NEUTRAL',
      signal: { direction: 'UNAVAILABLE' },
      chart: chartFrom(bars),
      bars
    };
  }
}

export async function getMarketRegime() {
  const rows = await Promise.all(['SPY', 'QQQ'].map(safeMarketRow));
  const spy = rows.find((row) => row.symbol === 'SPY');
  const qqq = rows.find((row) => row.symbol === 'QQQ');
  const bullish = [spy, qqq].some((row) => row?.trend === 'BULLISH');
  const bearish = [spy, qqq].some((row) => row?.trend === 'BEARISH');
  const regime = bullish ? 'BULLISH' : bearish ? 'BEARISH' : 'NEUTRAL';
  const compact = (row) => ({
    symbol: row?.symbol,
    price: row?.price,
    change_percent: row?.change_percent,
    trend: row?.trend,
    ema9: row?.indicators?.ema9,
    ema20: row?.indicators?.ema20,
    vwap: row?.indicators?.vwap
  });
  const payload = {
    id: nanoid(),
    regime,
    spy_status: spy?.trend || 'NEUTRAL',
    qqq_status: qqq?.trend || 'NEUTRAL',
    details_json: JSON.stringify({ SPY: compact(spy), QQQ: compact(qqq) })
  };
  db.prepare('INSERT INTO market_regime (id, regime, spy_status, qqq_status, details_json) VALUES (?, ?, ?, ?, ?)')
    .run(payload.id, payload.regime, payload.spy_status, payload.qqq_status, payload.details_json);
  return payload;
}

export function latestMarketRegime() {
  const row = db.prepare('SELECT * FROM market_regime ORDER BY created_at DESC LIMIT 1').get();
  return row || { regime: 'NEUTRAL', spy_status: 'NEUTRAL', qqq_status: 'NEUTRAL', details_json: '{}' };
}

function scoreCandidate(row, asset, settings, regime) {
  const reasons = [];
  const checks = [];
  const addCheck = (key, passed, reason, safety = false) => {
    checks.push({ key, passed, reason, safety });
    if (!passed) reasons.push(reason);
  };
  const price = Number(row.price || 0);
  const dailyVolume = Number(row.daily_volume || row.volume || 0);
  const latestVolume = Number(row.volume || 0);
  const avgVolume = Number(row.indicators?.volume_avg || 0) || 1;
  const relativeVolume = latestVolume / avgVolume;
  const percentChange = Number(row.change_percent || 0);
  const spread = Number(row.spread_percent || 0);
  const tradable = Boolean(asset?.tradable);
  const active = String(asset?.status || '').toLowerCase() === 'active';
  const exchange = asset?.exchange || '';
  const isOtc = exchange.toUpperCase().includes('OTC');
  const leveraged = /(^|[^A-Z])(2X|3X|BULL|BEAR|TQQQ|SQQQ|UPRO|SPXL|SPXS|SOXL|SOXS)([^A-Z]|$)/i.test(row.symbol);

  addCheck('minPrice', price >= settings.minPrice, `price below ${settings.minPrice}`);
  addCheck('maxPrice', price <= settings.maxPrice, `price above ${settings.maxPrice}`);
  addCheck('minDailyVolume', dailyVolume >= settings.minDailyVolume, `volume below ${settings.minDailyVolume}`);
  addCheck('minRelativeVolume', relativeVolume >= settings.minRelativeVolume, `relative volume below ${settings.minRelativeVolume}`);
  addCheck('minPercentChange', Math.abs(percentChange) >= settings.minPercentChange, `percent change below ${settings.minPercentChange}%`);
  addCheck('maxSpreadPercent', spread <= settings.maxSpreadPercent, `spread above ${settings.maxSpreadPercent}%`);
  if (settings.requireActive) addCheck('requireActive', active, 'asset not active', true);
  if (settings.requireTradable) addCheck('requireTradable', tradable, 'asset not tradable', true);
  if (settings.excludeOtc) addCheck('excludeOtc', !isOtc, 'OTC excluded', true);
  if (settings.excludeLeveragedEtfs) addCheck('excludeLeveragedEtfs', !leveraged, 'leveraged ETF excluded');

  const trendScore = row.trend === 'BULLISH' ? 20 : row.trend === 'NEUTRAL' ? 8 : 0;
  const regimeScore = regime.regime === 'BULLISH' || regime.regime === 'NEUTRAL' ? 10 : 0;
  const fractionableScore = asset?.fractionable ? 8 : settings.preferFractionable ? 0 : 4;
  const liquidityScore = Math.min(20, dailyVolume / 1000000);
  const relVolScore = Math.min(20, relativeVolume * 8);
  const changeScore = Math.min(15, Math.abs(percentChange) * 4);
  const spreadScore = Math.max(0, 10 - spread * 10);
  const score = trendScore + regimeScore + fractionableScore + liquidityScore + relVolScore + changeScore + spreadScore;

  return {
    passed: reasons.length === 0,
    reason: reasons.length ? reasons.join('; ') : 'passed scanner filters',
    score: Number(score.toFixed(2)),
    relativeVolume: Number(relativeVolume.toFixed(2)),
    averageVolume: Number(avgVolume.toFixed(0)),
    passedFilters: checks.filter((check) => check.passed).length,
    totalFilters: checks.length,
    blockers: checks.filter((check) => !check.passed).slice(0, 2).map((check) => check.reason),
    checks
  };
}

function rejectionSummary(rejections) {
  const counts = new Map();
  rejections.forEach((row) => {
    String(row.reason || 'unknown').split(';').map((item) => item.trim()).filter(Boolean).forEach((reason) => {
      counts.set(reason, (counts.get(reason) || 0) + 1);
    });
  });
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

function tuningSuggestions(summary) {
  return summary.slice(0, 4).map((item) => {
    if (item.reason.includes('volume below')) return 'Lower minimum daily volume or use Micro Account mode.';
    if (item.reason.includes('relative volume')) return 'Lower minimum relative volume by one step.';
    if (item.reason.includes('percent change')) return 'Lower minimum percent change or run Momentum Hunt later in the session.';
    if (item.reason.includes('spread above')) return 'Raise max spread only slightly; wide spreads increase fill risk.';
    if (item.reason.includes('price above')) return 'Lower max price only if you want smaller-account candidates.';
    return `Review ${item.reason}.`;
  }).filter((value, index, array) => array.indexOf(value) === index);
}

function saveSignalIfNeeded(row, regime) {
  const enableContextTrading = toBool(getSetting('enable_context_symbol_trading'), config.enableContextSymbolTrading);
  const isContext = contextSymbols.includes(row.symbol);
  if (isContext && !enableContextTrading) return { status: 'skipped', reason: 'context symbol trading disabled' };
  if (row.signal?.direction !== 'BUY') return { status: 'no_signal', reason: `quant direction ${row.signal?.direction || 'NONE'}` };
  if (!['BULLISH', 'NEUTRAL'].includes(regime.regime)) return { status: 'blocked_by_regime', reason: `market regime ${regime.regime} blocks long entries` };

  const existing = db.prepare(`
    SELECT id FROM signals
    WHERE symbol = ? AND direction = ? AND status = 'pending'
    AND created_at >= datetime('now', '-30 minutes')
  `).get(row.symbol, row.signal.direction);

  if (existing) return { status: 'duplicate_pending_signal', reason: 'pending signal already exists for this symbol' };

  if (!existing) {
    db.prepare(`
      INSERT INTO signals (id, symbol, direction, entry_price, stop_loss, take_profit, confidence, reason, status, strategy, expires_at, signal_price, stale_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'EMA_VWAP_MOMENTUM_V1', ?, ?, 'fresh')
    `).run(nanoid(), row.symbol, row.signal.direction, row.signal.entry_price, row.signal.stop_loss, row.signal.take_profit, row.signal.confidence, row.signal.reason, new Date(Date.now() + config.signalTtlSeconds * 1000).toISOString(), row.signal.entry_price);
    logEvent('info', 'signal_generated', { symbol: row.symbol, signal: row.signal });
  }
  return { status: 'created_signal', reason: 'pending BUY signal created' };
}

export async function scanContextWatchlist() {
  const rows = [];
  for (const symbol of contextSymbols) rows.push(await safeMarketRow(symbol));
  await getMarketRegime();
  return rows.map(({ bars, ...row }) => row);
}

export async function runTradingUniverseScanner(options = {}) {
  const preset = options.preset;
  const settings = preset ? applyScannerPreset(preset) : scannerSettings();
  const regime = await getMarketRegime();
  const runId = nanoid();
  db.prepare('INSERT INTO scanner_runs (id, status, settings_json) VALUES (?, ?, ?)')
    .run(runId, 'running', JSON.stringify(settings));
  emitEvent('Scanner', 'scanner_stage', 'Fetching assets and market data.', { runId, stage: 'fetching_assets' });

  const blocked = new Set(db.prepare("SELECT symbol FROM watchlist_groups WHERE group_name = 'blocked' AND enabled = 1").all().map((row) => row.symbol));
  const seedRows = db.prepare(`
    SELECT symbol FROM watchlist_groups
    WHERE group_name IN ('trading_universe', 'user_added') AND enabled = 1
  `).all();
  const symbols = [...new Set([...seedRows.map((row) => row.symbol), ...seedUniverse])].filter((symbol) => !blocked.has(symbol));
  const passedRows = [];
  const rejectedRows = [];
  let rejected = 0;

  for (const symbol of symbols) {
    try {
      const [row, asset] = await Promise.all([safeMarketRow(symbol), getAsset(symbol).catch(() => null)]);
      const scored = scoreCandidate(row, asset, settings, regime);
      const payload = {
        id: nanoid(),
        run_id: runId,
        symbol,
        name: asset?.name || symbol,
        price: row.price,
        percent_change: row.change_percent,
        volume: row.daily_volume || row.volume,
        average_volume: scored.averageVolume,
        relative_volume: scored.relativeVolume,
        spread_percent: row.spread_percent || 0,
        tradable: asset?.tradable ? 1 : 0,
        fractionable: asset?.fractionable ? 1 : 0,
        exchange: asset?.exchange || '',
        asset_status: asset?.status || '',
        score: scored.score,
        passed: scored.passed ? 1 : 0,
        reason: scored.reason,
        signal_status: row.signal?.direction || 'NONE',
        passed_filters: scored.passedFilters,
        total_filters: scored.totalFilters,
        blockers: scored.blockers
      };
      const dbPayload = { ...payload };
      delete dbPayload.passed_filters;
      delete dbPayload.total_filters;
      delete dbPayload.blockers;
      db.prepare(`
        INSERT INTO trading_universe_candidates
        (id, run_id, symbol, name, price, percent_change, volume, average_volume, relative_volume, spread_percent, tradable, fractionable, exchange, asset_status, score, passed, reason, signal_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...Object.values(dbPayload));

      if (scored.passed) {
        const signalGeneration = saveSignalIfNeeded(row, regime);
        passedRows.push({ ...payload, signal: row.signal, trend: row.trend, signal_generation_status: signalGeneration.status, signal_generation_reason: signalGeneration.reason });
        emitEvent('Scanner', 'candidate_passed', `${symbol} passed scanner filters.`, { runId, symbol, score: scored.score });
      } else {
        rejected += 1;
        rejectedRows.push(payload);
        db.prepare('INSERT INTO scanner_rejections (id, run_id, symbol, reason) VALUES (?, ?, ?, ?)')
          .run(nanoid(), runId, symbol, scored.reason);
        emitEvent('Scanner', 'candidate_rejected', `${symbol} rejected: ${scored.reason}`, { runId, symbol, reason: scored.reason });
      }
    } catch (error) {
      rejected += 1;
      rejectedRows.push({ id: nanoid(), run_id: runId, symbol, reason: error.message, passed_filters: 0, total_filters: 1, blockers: [error.message], score: 0 });
      db.prepare('INSERT INTO scanner_rejections (id, run_id, symbol, reason) VALUES (?, ?, ?, ?)')
        .run(nanoid(), runId, symbol, error.message);
      logEvent('error', 'scanner_symbol_error', { runId, symbol, message: error.message });
    }
  }

  passedRows.sort((a, b) => b.score - a.score);
  const kept = passedRows.slice(0, settings.maxResults);
  db.prepare(`
    UPDATE scanner_runs
    SET status = 'completed', total_scanned = ?, passed_count = ?, rejected_count = ?, completed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(symbols.length, kept.length, rejected + Math.max(0, passedRows.length - kept.length), runId);
  emitEvent('Scanner', 'scanner_stage', 'Ranking candidates completed.', { runId, stage: 'completed' });
  logEvent('info', 'scanner_run_completed', { runId, scanned: symbols.length, passed: kept.length });
  const rejections = db.prepare('SELECT * FROM scanner_rejections WHERE run_id = ? ORDER BY scanned_at DESC').all(runId);
  const summary = rejectionSummary(rejections);
  const signalGeneration = passedRows.reduce((acc, row) => {
    const status = row.signal_generation_status || 'unknown';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const closest = rejectedRows
    .sort((a, b) => (b.passed_filters - a.passed_filters) || (b.score - a.score))
    .slice(0, 10);
  return {
    runId,
    regime,
    settings,
    activeFilters: settings,
    passed: kept,
    rejected: rejections,
    rejectedCount: rejected,
    signalGeneration,
    rejectionReasons: summary,
    closestToPassing: closest,
    suggestedTuning: tuningSuggestions(summary)
  };
}

export function latestTradingUniverse() {
  return db.prepare(`
    SELECT * FROM trading_universe_candidates
    WHERE passed = 1 AND run_id = (SELECT id FROM scanner_runs WHERE status = 'completed' ORDER BY created_at DESC LIMIT 1)
    ORDER BY score DESC
  `).all();
}

export function scannerRuns() {
  return db.prepare('SELECT * FROM scanner_runs ORDER BY created_at DESC LIMIT 50').all();
}

export function scannerRun(id) {
  return {
    run: db.prepare('SELECT * FROM scanner_runs WHERE id = ?').get(id),
    passed: db.prepare('SELECT * FROM trading_universe_candidates WHERE run_id = ? AND passed = 1 ORDER BY score DESC').all(id),
    rejected: db.prepare('SELECT * FROM scanner_rejections WHERE run_id = ? ORDER BY scanned_at DESC').all(id)
  };
}

export function blockedSymbols() {
  return db.prepare("SELECT symbol, created_at FROM watchlist_groups WHERE group_name = 'blocked' AND enabled = 1 ORDER BY symbol").all();
}

export async function scanWatchlist() {
  return scanContextWatchlist();
}
