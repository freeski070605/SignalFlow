import Alpaca from '@alpacahq/alpaca-trade-api';
import { config } from './config.js';

const paper = config.alpacaBaseUrl.includes('paper');

export const alpaca = new Alpaca({
  keyId: config.alpacaApiKey,
  secretKey: config.alpacaSecretKey,
  paper,
  baseUrl: config.alpacaBaseUrl
});

function formatDetails(details) {
  if (!details) return 'Unknown Alpaca error';
  if (typeof details === 'string') return details;
  if (details.message) return details.message;
  if (details.error) return details.error;
  if (details.code && details.message) return `${details.code}: ${details.message}`;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function alpacaError(error, action) {
  const status = error?.response?.status || error?.statusCode || error?.status;
  const details = formatDetails(error?.response?.data || error?.message);
  const message = status
    ? `Alpaca ${action} failed (${status}): ${details}`
    : `Alpaca ${action} failed: ${details}`;
  return new Error(message);
}

async function callAlpaca(action, fn) {
  try {
    return await fn();
  } catch (error) {
    throw alpacaError(error, action);
  }
}

export function hasAlpacaCredentials() {
  return Boolean(config.alpacaApiKey && config.alpacaSecretKey);
}

export async function getAccount() {
  if (!hasAlpacaCredentials()) {
    return {
      equity: '0',
      buying_power: '0',
      cash: '0',
      status: 'missing_credentials',
      trading_blocked: true
    };
  }
  return callAlpaca('account request', () => alpaca.getAccount());
}

export async function getPositions() {
  if (!hasAlpacaCredentials()) return [];
  return callAlpaca('positions request', () => alpaca.getPositions());
}

export async function getOrders() {
  if (!hasAlpacaCredentials()) return [];
  return callAlpaca('orders request', () => alpaca.getOrders({ status: 'all', limit: 100, direction: 'desc' }));
}

export async function cancelOrder(orderId) {
  if (!hasAlpacaCredentials()) throw new Error('Alpaca credentials are missing');
  return callAlpaca('order cancellation', () => alpaca.cancelOrder(orderId));
}

export async function closePosition(symbol) {
  if (!hasAlpacaCredentials()) throw new Error('Alpaca credentials are missing');
  return callAlpaca(`${symbol} position close`, () => alpaca.closePosition(symbol));
}

export async function getMarketClock() {
  if (!hasAlpacaCredentials()) {
    return { is_open: false, status: 'missing_credentials', next_open: null, next_close: null };
  }
  return callAlpaca('market clock request', () => alpaca.getClock());
}

export async function getAsset(symbol) {
  if (!hasAlpacaCredentials()) return null;
  return callAlpaca(`${symbol} asset request`, () => alpaca.getAsset(symbol));
}

export async function getLatestQuote(symbol) {
  if (!hasAlpacaCredentials()) return null;
  return callAlpaca(`${symbol} quote request`, async () => {
    const quote = await alpaca.getLatestQuote(symbol, { feed: config.alpacaDataFeed });
    const ask = Number(quote.AskPrice ?? quote.ap ?? quote.ask_price ?? 0);
    const bid = Number(quote.BidPrice ?? quote.bp ?? quote.bid_price ?? 0);
    const mid = ask && bid ? (ask + bid) / 2 : 0;
    return {
      ask,
      bid,
      spreadPercent: mid ? ((ask - bid) / mid) * 100 : 0
    };
  });
}

export async function getLatestSnapshot(symbol) {
  if (!hasAlpacaCredentials()) return null;
  return callAlpaca(`${symbol} bars request`, async () => {
    const bars = [];
    const end = new Date();
    const start = new Date(end.getTime() - 1000 * 60 * 60 * 8);
    const iterator = alpaca.getBarsV2(symbol, {
      start: start.toISOString(),
      end: end.toISOString(),
      timeframe: '5Min',
      feed: config.alpacaDataFeed,
      limit: 120
    });
    for await (const bar of iterator) bars.push({
      timestamp: bar.Timestamp || bar.t,
      open: Number(bar.OpenPrice ?? bar.o),
      high: Number(bar.HighPrice ?? bar.h),
      low: Number(bar.LowPrice ?? bar.l),
      close: Number(bar.ClosePrice ?? bar.c),
      volume: Number(bar.Volume ?? bar.v)
    });
    return bars;
  });
}

export async function getLatestPrice(symbol) {
  const bars = await getLatestSnapshot(symbol);
  const last = bars?.at(-1);
  if (!last?.close) throw new Error(`No latest price available for ${symbol}`);
  return Number(last.close);
}

export async function submitSimpleNotionalBuyOrder({ symbol, notional }) {
  return callAlpaca('fractional entry submission', () => alpaca.createOrder({
    symbol,
    side: 'buy',
    type: 'market',
    time_in_force: 'day',
    notional: Number(notional).toFixed(2)
  }));
}

export async function submitBracketNotionalOrder({ symbol, side, qty, stopLoss, takeProfit }) {
  return callAlpaca('order submission', () => alpaca.createOrder({
    symbol,
    side,
    type: 'market',
    time_in_force: 'day',
    qty: String(Math.floor(Number(qty))),
    order_class: 'bracket',
    take_profit: { limit_price: Number(takeProfit).toFixed(2) },
    stop_loss: { stop_price: Number(stopLoss).toFixed(2) }
  }));
}

export async function submitMarketExitOrder({ symbol, qty }) {
  return callAlpaca('exit order submission', () => alpaca.createOrder({
    symbol,
    side: 'sell',
    type: 'market',
    time_in_force: 'day',
    qty: Math.abs(Number(qty)).toFixed(9)
  }));
}
