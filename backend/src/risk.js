import { nanoid } from 'nanoid';
import { config } from './config.js';
import { db, getSetting, logEvent } from './db.js';
import { getAccount, getOrders, getPositions } from './alpaca.js';

const openOrderStatuses = new Set(['new', 'accepted', 'pending_new', 'partially_filled']);

function riskBlock(signal, reason, options = {}) {
  if (!options.preview) {
    db.prepare('INSERT INTO risk_events (id, signal_id, symbol, reason) VALUES (?, ?, ?, ?)')
      .run(nanoid(), signal?.id || null, signal?.symbol || null, reason);
    logEvent('warn', 'risk_rejected_signal', { signalId: signal?.id, symbol: signal?.symbol, reason });
  }
  return { ok: false, reason };
}

const settingNum = (key, fallback) => {
  const parsed = Number(getSetting(key, fallback));
  return Number.isFinite(parsed) ? parsed : fallback;
};

const settingBool = (key, fallback) => {
  const value = getSetting(key, fallback);
  return String(value).toLowerCase() === 'true';
};

export async function evaluateRisk(signal, options = {}) {
  if (getSetting('kill_switch', 'false') === 'true' && signal.direction !== 'SELL') {
    return riskBlock(signal, 'Emergency kill switch is active.', options);
  }

  if (!signal.stop_loss || !signal.take_profit) {
    return riskBlock(signal, 'Stop loss and take profit are required.', options);
  }

  const entry = Number(signal.entry_price);
  const stop = Number(signal.stop_loss);
  const stopDistance = Math.abs(entry - stop);
  if (!entry || !stopDistance) return riskBlock(signal, 'Entry price and stop distance must be valid.', options);

  const account = await getAccount();
  const equity = Number(account.equity || 0);
  const riskPerTradePercent = settingNum('risk_per_trade_percent', config.riskPerTradePercent);
  const maxAccountPositionPercent = settingNum('max_account_position_percent', config.maxAccountPositionPercent);
  const maxDailyLossPercent = settingNum('max_daily_loss_percent', config.maxDailyLossPercent);
  const minNotionalOrder = settingNum('min_notional_order', config.minNotionalOrder);
  const protectionModeSetting = getSetting('protection_mode', config.protectionMode);
  const monitoredEnabled = settingBool('allow_monitored_fractional_exits', config.allowMonitoredFractionalExits);

  const riskAmount = equity * (riskPerTradePercent / 100);
  const idealQuantity = riskAmount / stopDistance;
  const maxNotional = equity * (maxAccountPositionPercent / 100);
  const finalNotional = Math.min(idealQuantity * entry, maxNotional);
  const estimatedQty = finalNotional / entry;
  const tradeRisk = stopDistance * estimatedQty;

  if (finalNotional < minNotionalOrder) {
    return riskBlock(signal, 'Calculated position size below minimum notional order.', options);
  }

  if (tradeRisk > riskAmount) {
    return riskBlock(signal, 'Trade risk exceeds calculated risk-per-trade amount.', options);
  }

  const positions = await getPositions();
  const openPositions = positions.filter((position) => Math.abs(Number(position.qty || 0)) > 0);
  const sameTickerPosition = openPositions.find((position) => position.symbol === signal.symbol);

  if (signal.direction === 'SELL' && !sameTickerPosition) {
    return riskBlock(signal, 'SELL signals are exit-only and require an existing long position.', options);
  }

  if (signal.direction === 'SELL') {
    return { ok: true, notional: Math.abs(Number(sameTickerPosition.market_value || 0)), exitPosition: sameTickerPosition, protectionMode: 'exit_only' };
  }

  const stale = db.prepare("SELECT COUNT(*) AS count FROM monitored_positions WHERE status IN ('stale', 'manual_attention_required', 'failed')").get().count;
  if (stale > 0) {
    return riskBlock(signal, 'Monitored exit state requires manual attention before new entries.', options);
  }

  if (estimatedQty < 1) {
    if (protectionModeSetting === 'native_bracket' || !monitoredEnabled) {
      return riskBlock(
        signal,
        `Fractional entry requires monitored fractional-exit mode. Alpaca does not support fractional bracket orders. ${signal.symbol} would require ${estimatedQty.toFixed(6)} shares with calculated notional $${finalNotional.toFixed(2)}.`,
        options
      );
    }
    return {
      ok: true,
      notional: finalNotional,
      qty: estimatedQty,
      protectionMode: 'monitored_fractional',
      sizing: { equity, riskAmount, stopDistance, idealQuantity, maxNotional, finalNotional, tradeRisk }
    };
  }

  if (openPositions.length >= config.maxOpenPositions) {
    return riskBlock(signal, 'MAX_OPEN_POSITIONS reached.', options);
  }

  if (sameTickerPosition) {
    return riskBlock(signal, 'An open position already exists for this ticker.', options);
  }

  const orders = await getOrders();
  const duplicateOrder = orders.find((order) => order.symbol === signal.symbol && openOrderStatuses.has(order.status));
  if (duplicateOrder) {
    return riskBlock(signal, 'A duplicate open order exists for this ticker.', options);
  }

  const unrealized = openPositions.reduce((sum, position) => sum + Number(position.unrealized_pl || 0), 0);
  const closedPnl = db.prepare(`
    SELECT COALESCE(SUM(pnl), 0) AS pnl FROM trades
    WHERE date(created_at) = date('now') AND status = 'closed'
  `).get().pnl;
  const dailyPnl = Number(closedPnl) + unrealized;
  const dailyLossLimit = Math.max(Math.abs(config.maxDailyLoss), equity * (maxDailyLossPercent / 100));
  if (dailyPnl <= -dailyLossLimit) {
    return riskBlock(signal, 'MAX_DAILY_LOSS reached.', options);
  }

  return {
    ok: true,
    notional: finalNotional,
    qty: Math.floor(estimatedQty),
    protectionMode: 'native_bracket',
    sizing: { equity, riskAmount, stopDistance, idealQuantity, maxNotional, finalNotional, tradeRisk }
  };
}
