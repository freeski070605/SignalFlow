import { config } from '../config.js';

const forexSymbols = ['EUR-USD', 'GBP-USD', 'USD-JPY', 'USD-CHF', 'AUD-USD', 'USD-CAD', 'NZD-USD', 'EUR-JPY', 'GBP-JPY', 'EUR-GBP'];

const missingCredentials = () => !config.forexApiBaseUrl || !config.forexUsername || !config.forexPassword || !config.forexAccountId;

export function forexSessionStatus(date = new Date()) {
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
  const sessions = [];
  if (hour >= 21 || hour < 6) sessions.push('Sydney');
  if (hour >= 23 || hour < 8) sessions.push('Tokyo');
  if (hour >= 7 && hour < 16) sessions.push('London');
  if (hour >= 12 && hour < 21) sessions.push('New York');
  const overlap = [];
  if (sessions.includes('London') && sessions.includes('New York')) overlap.push('London/New York');
  if (sessions.includes('Sydney') && sessions.includes('Tokyo')) overlap.push('Sydney/Tokyo');
  return { openSessions: sessions, overlaps: overlap, label: sessions.length ? sessions.join(' + ') : 'Weekend/Closed or thin liquidity', updatedAt: date.toISOString() };
}

function adapterState(error = null) {
  if (!config.enableForexModule) return { status: 'Disabled', connected: false, enabled: false, reason: 'FOREX_MODULE_ENABLED=false' };
  if (missingCredentials()) return { status: 'Not Connected', connected: false, enabled: true, reason: 'Connect a FOREX.com API-enabled account to activate live forex data.' };
  if (error) return { status: 'Error', connected: false, enabled: true, reason: error.message || String(error) };
  return { status: config.forexEnv === 'live' ? 'Live Connected' : 'Demo Connected', connected: true, enabled: true, reason: null };
}

function unavailable(method) {
  const state = adapterState();
  if (!state.connected) {
    const error = new Error(`${method} unavailable: ${state.reason}`);
    error.adapterState = state;
    throw error;
  }
  const error = new Error(`${method} is not implemented for this FOREX.com API account yet. No fake forex data is available.`);
  error.adapterState = adapterState(error);
  throw error;
}

export const forexComAdapter = {
  name: 'forex.com',
  marketType: 'forex',
  market_type: 'forex',
  exchange_or_broker: 'FOREX.com',
  broker: 'forex.com',
  symbols: forexSymbols,
  status: async () => ({ ...adapterState(), broker: 'FOREX.com', env: config.forexEnv, tradingEnabled: config.forexTradingEnabled, autoExecutionEnabled: config.forexAutoExecution && config.autoExecution, session: forexSessionStatus() }),
  getAccount: async () => ({ status: adapterState().status, broker: 'FOREX.com', env: config.forexEnv, connected: adapterState().connected }),
  getBalances: async () => adapterState().connected ? unavailable('getBalances') : [],
  getTradableAssets: async () => adapterState().connected ? forexSymbols.map((symbol) => ({ symbol, tradable: false, market_type: 'forex', broker: 'FOREX.com', reason: 'Instrument validation requires live FOREX.com API metadata.' })) : [],
  getUniverse: async () => forexSymbols,
  getProducts: async () => forexSymbols.map((symbol) => ({ id: symbol, product_id: symbol, market_type: 'forex' })),
  getTicker: async (symbol) => unavailable(`getTicker(${symbol})`),
  getCandles: async (symbol, timeframe) => unavailable(`getCandles(${symbol}, ${timeframe})`),
  getOrderBook: async (symbol) => unavailable(`getOrderBook(${symbol})`),
  getOpenPositions: async () => adapterState().connected ? unavailable('getOpenPositions') : [],
  getOpenOrders: async () => adapterState().connected ? unavailable('getOpenOrders') : [],
  submitOrder: async () => {
    throw new Error('FOREX.com order submission is disabled. FOREX_TRADING_ENABLED and manual approval are required before live forex orders can be implemented.');
  },
  cancelOrder: async (orderId) => unavailable(`cancelOrder(${orderId})`),
  closePosition: async (symbol) => unavailable(`closePosition(${symbol})`),
  getMarketClock: async () => forexSessionStatus(),
  getMarketRegime: async () => ({ regime: 'UNAVAILABLE', reason: 'FOREX.com real market data is not connected.', session: forexSessionStatus() }),
  normalizeSymbol: (symbol = '') => String(symbol).trim().toUpperCase().replace('/', '-'),
  formatSymbol: (symbol = '') => String(symbol).trim().toUpperCase().replace('-', '/')
};
