import { config } from './config.js';
import { db, getSetting } from './db.js';
import { coinbaseCryptoAdapter } from './adapters/coinbaseCryptoAdapter.js';

const num = (key, fallback) => {
  const parsed = Number(getSetting(key, fallback));
  return Number.isFinite(parsed) ? parsed : fallback;
};

function block(reason) {
  return { ok: false, reason };
}

export async function evaluateCryptoRisk(signal) {
  if (getSetting('kill_switch', 'false') === 'true' && signal.direction !== 'SELL') return block('Emergency kill switch is active.');
  if (signal.direction === 'SELL') return { ok: true, protectionMode: 'exit_only' };
  if (signal.direction !== 'BUY') return block('Only spot BUY entries and SELL exits are supported for crypto V1.');

  const dailyTrades = db.prepare(`
    SELECT COUNT(*) AS count FROM orders
    WHERE market_type = 'crypto' AND date(created_at) = date('now')
  `).get().count;
  if (dailyTrades >= num('crypto_daily_trade_limit', config.cryptoDailyTradeLimit)) return block('CRYPTO_DAILY_TRADE_LIMIT reached.');

  const positions = await coinbaseCryptoAdapter.getOpenPositions();
  if (positions.length >= num('crypto_max_open_positions', config.cryptoMaxOpenPositions)) return block('CRYPTO_MAX_OPEN_POSITIONS reached.');
  if (positions.some((row) => row.symbol === signal.symbol)) return block('A crypto position already exists for this symbol.');

  const openOrders = await coinbaseCryptoAdapter.getOpenOrders();
  if (openOrders.some((row) => row.product_id === signal.symbol || row.symbol === signal.symbol)) return block('A duplicate open crypto order exists for this symbol.');

  const ticker = await coinbaseCryptoAdapter.getTicker(signal.symbol);
  if (Number(ticker.spreadPercent || 0) > num('crypto_max_spread_percent', config.cryptoMaxSpreadPercent)) return block('Crypto spread is above max spread setting.');

  const balances = await coinbaseCryptoAdapter.getBalances().catch(() => []);
  const usd = balances.find((row) => row.asset === 'USD');
  const equity = Number(usd?.available || 0);
  const fallbackEquity = equity || Number(getSetting('paper_crypto_equity', 20));
  const entry = Number(signal.entry_price);
  const stop = Number(signal.stop_loss);
  const stopDistance = Math.abs(entry - stop);
  if (!entry || !stopDistance) return block('Entry price and stop distance must be valid.');

  const riskAmount = fallbackEquity * (num('crypto_risk_per_trade_percent', config.cryptoRiskPerTradePercent) / 100);
  const idealQuantity = riskAmount / stopDistance;
  const maxNotional = fallbackEquity * (num('crypto_max_account_position_percent', config.cryptoMaxAccountPositionPercent) / 100);
  const finalNotional = Math.min(idealQuantity * entry, maxNotional);
  if (finalNotional < num('crypto_min_notional_order', config.cryptoMinNotionalOrder)) return block('Calculated crypto position size is below minimum notional.');
  const qty = finalNotional / entry;
  return {
    ok: true,
    notional: finalNotional,
    qty,
    protectionMode: 'signalflow_monitor',
    sizing: {
      equity: fallbackEquity,
      riskAmount,
      stopDistance,
      idealQuantity,
      maxNotional,
      finalNotional,
      tradeRisk: stopDistance * qty
    }
  };
}
