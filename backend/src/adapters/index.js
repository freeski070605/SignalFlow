export { marketAdapterContract } from './MarketAdapter.js';
export { alpacaStockAdapter } from './alpacaStockAdapter.js';
export { coinbaseCryptoAdapter } from './coinbaseCryptoAdapter.js';
export { forexComAdapter } from './forexComAdapter.js';
export { allowedMarkets, marketRegistry, normalizeMarket, marketInfo, requireMarket, getMarketAdapter } from './adapterRegistry.js';

import { config } from '../config.js';
import { getMarketAdapter } from './adapterRegistry.js';

export function getAdapter(marketType = config.primaryMarket) {
  return getMarketAdapter(marketType);
}

export function activeAdapter() {
  return getAdapter(config.primaryMarket);
}
