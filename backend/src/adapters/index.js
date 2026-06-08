import { alpacaStockAdapter } from './alpacaStockAdapter.js';
import { coinbaseCryptoAdapter } from './coinbaseCryptoAdapter.js';
import { config } from '../config.js';

export const adapters = {
  stocks: {
    alpaca: alpacaStockAdapter
  },
  crypto: {
    coinbase: coinbaseCryptoAdapter
  }
};

export function getAdapter(marketType = config.primaryMarket, exchange = config.activeExchange) {
  if (marketType === 'stocks') return adapters.stocks.alpaca;
  if (marketType === 'crypto') return adapters.crypto[exchange] || adapters.crypto.coinbase;
  throw new Error(`No adapter configured for ${marketType}/${exchange}`);
}

export function activeAdapter() {
  return getAdapter(config.primaryMarket, config.activeExchange);
}
