import {
  cancelOrder,
  closePosition,
  getAccount,
  getAsset,
  getLatestQuote,
  getLatestSnapshot,
  getOrders,
  getPositions,
  submitBracketNotionalOrder,
  submitMarketExitOrder,
  submitSimpleNotionalBuyOrder
} from '../alpaca.js';

export const alpacaStockAdapter = {
  name: 'alpaca',
  marketType: 'stocks',
  getAccount,
  getBalances: async () => [],
  getTradableAssets: async () => [],
  getProducts: async () => [],
  getTicker: async (symbol) => {
    const bars = await getLatestSnapshot(symbol);
    const quote = await getLatestQuote(symbol);
    const last = bars?.at(-1);
    return { symbol, price: Number(last?.close || 0), ...quote };
  },
  getCandles: getLatestSnapshot,
  getOrderBook: async () => ({}),
  getOpenPositions: getPositions,
  getOpenOrders: getOrders,
  submitOrder: async (request) => {
    if (request.orderClass === 'bracket') return submitBracketNotionalOrder(request);
    if (request.side === 'sell') return submitMarketExitOrder(request);
    return submitSimpleNotionalBuyOrder(request);
  },
  cancelOrder,
  closePosition,
  subscribeMarketData: () => null,
  subscribeOrderUpdates: () => null,
  normalizeSymbol: (symbol) => symbol.toUpperCase(),
  formatSymbol: (symbol) => symbol.toUpperCase(),
  getAsset
};
