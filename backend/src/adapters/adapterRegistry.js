import { config } from '../config.js';
import { alpacaStockAdapter } from './alpacaStockAdapter.js';
import { coinbaseCryptoAdapter } from './coinbaseCryptoAdapter.js';
import { forexComAdapter } from './forexComAdapter.js';

export const allowedMarkets = ['crypto', 'stocks', 'forex'];

export const marketRegistry = {
  crypto: { market_type: 'crypto', label: 'Crypto', adapter_name: 'coinbase', exchange: 'coinbase', broker: null, enabled: config.enableCryptoModule, adapter: coinbaseCryptoAdapter },
  stocks: { market_type: 'stocks', label: 'Stocks', adapter_name: 'alpaca', exchange: 'alpaca', broker: 'alpaca', enabled: config.enableStocksModule, adapter: alpacaStockAdapter },
  forex: { market_type: 'forex', label: 'Forex', adapter_name: 'forex.com', exchange: 'forex.com', broker: 'FOREX.com', enabled: config.enableForexModule, adapter: forexComAdapter }
};

export function normalizeMarket(market = 'crypto') {
  const key = String(market || 'crypto').toLowerCase();
  return allowedMarkets.includes(key) ? key : null;
}

export function marketInfo(market = 'crypto') {
  const key = normalizeMarket(market);
  if (!key) return null;
  return marketRegistry[key];
}

export function requireMarket(market = 'crypto') {
  const info = marketInfo(market);
  if (!info) {
    const error = new Error('Market workspace not available.');
    error.status = 404;
    throw error;
  }
  return info;
}

export function getMarketAdapter(market = 'crypto') {
  return requireMarket(market).adapter;
}
