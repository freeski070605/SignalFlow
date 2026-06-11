import { config, executionMode } from './config.js';
import { allSettings, collections, getSetting, nowIso, setSetting, withoutMongoId, withoutMongoIds } from './db.js';
import { recentEvents } from './events.js';
import { coinbaseCryptoAdapter } from './adapters/coinbaseCryptoAdapter.js';
import { forexComAdapter } from './adapters/forexComAdapter.js';
import { marketInfo, requireMarket, allowedMarkets } from './adapters/adapterRegistry.js';
import { getAccount as alpacaAccount, getMarketClock, getPositions as alpacaPositions } from './alpaca.js';
import { cryptoMarketRegime, cryptoScannerSettingsPayload, cryptoStrategySettingsPayload, nearMissAnalytics, runCryptoScanner, saveCryptoScannerSettings, saveCryptoStrategySettings } from './cryptoScanner.js';
import { latestMarketRegime, runTradingUniverseScanner, scannerSettingsPayload, saveScannerSettings } from './watchlist.js';
import { monitorStatus } from './monitor.js';
import { strategyLabSummary } from './strategyLab.js';
import { strategiesForMarket } from './strategyRegistry.js';

const marketLabel = (market) => market === 'crypto' ? 'Crypto' : market === 'stocks' ? 'Stocks' : 'Forex';
const marketQuery = (market) => market === 'crypto'
  ? { $or: [{ market_type: 'crypto' }, { symbol: /-USD$/ }] }
  : market === 'stocks'
    ? { $or: [{ market_type: 'stocks' }, { market_type: { $exists: false }, symbol: { $not: /-USD$/ } }] }
    : { market_type: 'forex' };

async function pendingSignals(market) {
  return withoutMongoIds(await collections.signals.find({ status: 'pending', ...marketQuery(market) }).sort({ created_at: -1 }).limit(100).toArray());
}

async function journalRowsForMarket(market = 'all') {
  const query = market === 'all' ? {} : marketQuery(market);
  return withoutMongoIds(await collections.tradeJournal.find(query).sort({ closed_at: -1, created_at: -1 }).limit(500).toArray());
}

function aggregate(rows) {
  const wins = rows.filter((row) => Number(row.realized_pnl) > 0);
  const losses = rows.filter((row) => Number(row.realized_pnl) < 0);
  const grossWin = wins.reduce((sum, row) => sum + Number(row.realized_pnl || 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, row) => sum + Number(row.realized_pnl || 0), 0));
  return { totalTrades: rows.length, wins: wins.length, losses: losses.length, totalPnl: rows.reduce((sum, row) => sum + Number(row.realized_pnl || 0), 0), winRate: rows.length ? (wins.length / rows.length) * 100 : 0, profitFactor: grossLoss ? grossWin / grossLoss : grossWin ? Infinity : 0 };
}

async function performanceForMarket(market) {
  const rows = await journalRowsForMarket(market);
  const group = (key) => [...rows.reduce((acc, row) => acc.set(row[key] || 'unknown', [...(acc.get(row[key] || 'unknown') || []), row]), new Map()).entries()].map(([name, items]) => ({ name, ...aggregate(items) }));
  return { ...aggregate(rows), strategy: group('strategy_name'), symbols: group('symbol'), daily: group('day') };
}

async function adapterStatusForMarket(market) {
  if (market === 'forex') return forexComAdapter.status();
  if (market === 'crypto') {
    const account = await coinbaseCryptoAdapter.getAccount().catch((error) => ({ status: 'ERROR', error: error.message }));
    return { status: account.status === 'CONNECTED' ? 'connected' : account.error ? 'error' : 'missing credentials', connected: account.status === 'CONNECTED', adapter_name: 'coinbase', exchange: 'coinbase', error: account.error || null };
  }
  const account = await alpacaAccount().catch((error) => ({ status: 'ERROR', error: error.message }));
  return { status: account.status && account.status !== 'ERROR' ? 'connected' : account.error ? 'error' : 'missing credentials', connected: Boolean(account.status && account.status !== 'ERROR'), adapter_name: 'alpaca', broker: 'alpaca', error: account.error || null };
}

export async function marketDashboard(market) {
  requireMarket(market);
  const signals = await pendingSignals(market).catch(() => []);
  const adapterStatus = await adapterStatusForMarket(market).catch((error) => ({ status: 'error', connected: false, error: error.message }));
  const base = { market_type: market, label: marketLabel(market), adapterStatus, pendingSignals: signals.length, strategies: strategiesForMarket(market), killSwitch: getSetting(`${market}_kill_switch`, market === 'forex' ? 'true' : 'false') === 'true' };

  if (market === 'crypto') {
    const [balances, positions, regime, monitor, nearMiss] = await Promise.all([
      coinbaseCryptoAdapter.getBalances().catch(() => []),
      coinbaseCryptoAdapter.getOpenPositions().catch(() => []),
      cryptoMarketRegime().catch((error) => ({ regime: 'NEUTRAL', error: error.message })),
      monitorStatus().catch(() => ({})),
      nearMissAnalytics().catch(() => null)
    ]);
    const usd = balances.find((row) => row.asset === 'USD');
    return { ...base, exchange: 'Coinbase', usdBalance: usd?.available || 0, positions, openPositions: positions.length, openRisk: 0, regime, scannerState: { enabled: getSetting('auto_crypto_scanner', config.autoCryptoScanner) === 'true' }, protectionMode: 'SignalFlow Monitor', monitor, nearMiss };
  }
  if (market === 'stocks') {
    const [account, positions, clock, regime] = await Promise.all([
      alpacaAccount().catch((error) => ({ error: error.message })),
      alpacaPositions().catch(() => []),
      getMarketClock().catch((error) => ({ error: error.message })),
      latestMarketRegime().catch((error) => ({ regime: 'NEUTRAL', error: error.message }))
    ]);
    return { ...base, broker: 'Alpaca', accountEquity: account.equity || 0, buyingPower: account.buying_power || 0, cash: account.cash || 0, positions, openPositions: positions.length, openRisk: positions.reduce((sum, row) => sum + Math.max(0, -Number(row.unrealized_pl || 0)), 0), marketClock: clock, regime, scannerState: { enabled: true }, protectionMode: getSetting('protection_mode', config.protectionMode) };
  }
  const status = await forexComAdapter.status();
  return { ...base, broker: 'FOREX.com', adapterStatus: status, accountBalance: null, marginAvailable: null, positions: [], openPositions: 0, openRisk: 0, session: status.session, lastPriceUpdate: null, unavailableMessage: status.connected ? 'FOREX.com connected, but live data endpoints are not enabled in this adapter yet.' : 'Connect a FOREX.com API-enabled account to activate live forex data.' };
}

export async function globalDashboard() {
  const [crypto, stocks, forex, events, monitor] = await Promise.all([
    marketDashboard('crypto'),
    marketDashboard('stocks'),
    marketDashboard('forex'),
    recentEvents(100, 'all').catch(() => []),
    monitorStatus().catch(() => ({}))
  ]);
  const markets = { crypto, stocks, forex };
  return {
    title: 'Global Dashboard',
    activeMarketDefault: getSetting('active_market', 'crypto'),
    tradingMode: executionMode(),
    protectionMode: getSetting('protection_mode', config.protectionMode),
    markets,
    risk: {
      totalOpenPositions: Object.values(markets).reduce((sum, row) => sum + Number(row.openPositions || 0), 0),
      totalPendingSignals: Object.values(markets).reduce((sum, row) => sum + Number(row.pendingSignals || 0), 0),
      globalKillSwitch: getSetting('global_kill_switch', getSetting('kill_switch', 'false')) === 'true',
      marketKillSwitches: Object.fromEntries(allowedMarkets.map((market) => [market, getSetting(`${market}_kill_switch`, market === 'forex' ? 'true' : 'false') === 'true'])),
      monitorWarnings: Number(monitor.stale || 0) + Number(monitor.manualAttention || 0)
    },
    balances: { cryptoUsdBalance: crypto.usdBalance ?? null, stockAccountEquity: stocks.accountEquity ?? null, forexAccountBalance: forex.accountBalance ?? null },
    events,
    generatedAt: nowIso()
  };
}

export async function marketScannerSettings(market) {
  if (market === 'crypto') return cryptoScannerSettingsPayload();
  if (market === 'stocks') return scannerSettingsPayload();
  return { settings: { market_type: 'forex', enabled: false }, unavailable: true, message: 'Connect a FOREX.com API-enabled account to activate live forex data.' };
}

export async function saveMarketScannerSettings(market, payload) {
  if (market === 'crypto') return { settings: saveCryptoScannerSettings(payload || {}), presets: cryptoScannerSettingsPayload().presets };
  if (market === 'stocks') return saveScannerSettings(payload || {});
  return { unavailable: true, message: 'Forex scanner settings are locked until FOREX.com is connected.' };
}

export async function runMarketScanner(market, preset) {
  if (market === 'crypto') return runCryptoScanner({ preset });
  if (market === 'stocks') return runTradingUniverseScanner({ preset });
  return { marketType: 'forex', unavailable: true, passed: [], rejected: [], message: 'Connect a FOREX.com API-enabled account to activate live forex data.' };
}

export async function marketSignals(market) { return pendingSignals(market); }
export async function marketPositions(market) { return market === 'crypto' ? coinbaseCryptoAdapter.getOpenPositions().catch(() => []) : market === 'stocks' ? alpacaPositions().catch(() => []) : []; }
export async function marketJournal(market) { return { rows: await journalRowsForMarket(market), mistakeTags: [] }; }
export async function marketPerformance(market) { return performanceForMarket(market); }
export async function marketStrategyLab(market) { return market === 'crypto' ? strategyLabSummary() : { market_type: market, strategies: strategiesForMarket(market), rows: [], message: market === 'forex' ? 'FOREX.com real data is required before forex Strategy Lab statistics are available.' : 'No stock strategy simulations are available yet.' }; }
export async function marketSettings(market) { return { market_type: market, global: allSettings(), scanner: await marketScannerSettings(market), strategy: market === 'crypto' ? cryptoStrategySettingsPayload() : { strategies: strategiesForMarket(market) }, adapterStatus: await adapterStatusForMarket(market) }; }
export async function saveMarketSettings(market, payload = {}) { Object.entries(payload).forEach(([key, value]) => setSetting(`${market}_${key}`, value)); return marketSettings(market); }
