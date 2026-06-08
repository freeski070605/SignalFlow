import { config } from './config.js';
import { collections, getSetting, nowIso, withoutMongoId } from './db.js';
import { emitEvent } from './events.js';
import { safeMarketRow, latestMarketRegime } from './watchlist.js';
import { getAsset } from './alpaca.js';
import { coinbaseCryptoAdapter } from './adapters/coinbaseCryptoAdapter.js';
import { cryptoMarketRegime } from './cryptoScanner.js';
import { broadcast } from './ws.js';
import { analyzeExpiredSignalOutcome } from './journal.js';

let timer = null;

const pctMove = (from, to) => {
  const base = Number(from || 0);
  const current = Number(to || 0);
  return base ? ((current - base) / base) * 100 : 0;
};

export function signalExpiryFromNow() {
  return new Date(Date.now() + config.signalTtlSeconds * 1000).toISOString();
}

export function secondsRemaining(signal) {
  if (!signal?.expires_at) return 0;
  return Math.max(0, Math.ceil((new Date(signal.expires_at).getTime() - Date.now()) / 1000));
}

export async function expireSignal(signal, reason) {
  if (!signal || signal.status !== 'pending') return null;
  const at = nowIso();
  await collections.signals.updateOne(
    { id: signal.id, status: 'pending' },
    { $set: { status: 'expired', expired_at: at, expiration_reason: reason, stale_status: 'expired', resolved_at: at } }
  );
  emitEvent('Signals', 'signal_expired', `${signal.symbol} signal expired: ${reason}.`, { signalId: signal.id, symbol: signal.symbol, reason }, 'warn');
  broadcast('signal_expired', { id: signal.id, symbol: signal.symbol, reason });
  const expired = withoutMongoId(await collections.signals.findOne({ id: signal.id }));
  analyzeExpiredSignalOutcome(expired).catch((error) => {
    emitEvent('Signals', 'signal_outcome_analysis_failed', `${signal.symbol} outcome analysis failed: ${error.message}`, { signalId: signal.id, symbol: signal.symbol }, 'warn');
  });
  return expired;
}

async function expirationReason(signal) {
  const now = Date.now();
  const expiresAt = signal.expires_at ? new Date(signal.expires_at).getTime() : new Date(signal.created_at).getTime() + config.signalTtlSeconds * 1000;
  if (now >= expiresAt) return 'ttl_expired';

  const market = signal.market_type === 'crypto'
    ? await coinbaseCryptoAdapter.getTicker(signal.symbol)
    : await safeMarketRow(signal.symbol);
  const price = Number(market.price || 0);
  const signalPrice = Number(signal.signal_price || signal.entry_price || 0);
  if (Math.abs(pctMove(signalPrice, price)) > config.maxExtensionFromSignalPercent) return 'price_moved_too_far';

  const regime = signal.market_type === 'crypto'
    ? await cryptoMarketRegime().catch(() => ({ regime: 'NEUTRAL' }))
    : await latestMarketRegime();
  if (signal.direction === 'BUY' && regime.regime === 'BEARISH') return 'market_regime_changed';

  const asset = signal.market_type === 'crypto' ? { status: 'active', tradable: true } : await getAsset(signal.symbol).catch(() => null);
  if (asset && String(asset.status || '').toLowerCase() !== 'active') return 'symbol_no_longer_tradable';
  if (asset && !asset.tradable) return 'symbol_no_longer_tradable';

  const maxSpread = signal.market_type === 'crypto'
    ? Number(getSetting('crypto_max_spread_percent', config.cryptoMaxSpreadPercent))
    : Number(getSetting('max_spread_percent', config.scanner.maxSpreadPercent));
  if (Number(market.spread_percent || market.spreadPercent || 0) > maxSpread) return 'spread_too_wide';

  return null;
}

export async function expirePendingSignals() {
  const rows = await collections.signals.find({ status: 'pending' })
    .sort({ created_at: 1 })
    .limit(100)
    .toArray();
  for (const signal of rows) {
    try {
      const remaining = secondsRemaining(signal);
      if (remaining > 0 && remaining <= 60 && signal.stale_status !== 'expiring_soon') {
        await collections.signals.updateOne({ id: signal.id }, { $set: { stale_status: 'expiring_soon' } });
        emitEvent('Signals', 'signal_expiring_soon', `${signal.symbol} signal expires in ${remaining}s.`, { signalId: signal.id, symbol: signal.symbol, secondsRemaining: remaining }, 'warn');
        broadcast('signal_status', { id: signal.id, symbol: signal.symbol, stale_status: 'expiring_soon', secondsRemaining: remaining });
      }
      const reason = await expirationReason(signal);
      if (reason) await expireSignal(signal, reason);
    } catch (error) {
      emitEvent('Signals', 'signal_expiration_check_failed', `${signal.symbol} expiration check failed: ${error.message}`, { signalId: signal.id }, 'warn');
    }
  }
}

export function startSignalExpirationJob() {
  if (timer) return;
  timer = setInterval(() => {
    expirePendingSignals().catch((error) => {
      emitEvent('Signals', 'signal_expiration_job_failed', error.message, {}, 'critical');
    });
  }, 15000);
  emitEvent('Signals', 'signal_expiration_job_started', 'Signal expiration job started.', { intervalMs: 15000, ttlSeconds: config.signalTtlSeconds });
}

export async function validateSignalBeforeApproval(signal) {
  if (!signal) return { ok: false, status: 404, reason: 'Signal not found' };
  if (signal.status !== 'pending') return { ok: false, status: 409, reason: `Signal is not pending (${signal.status})` };
  if (signal.expired_at || signal.status === 'expired') return { ok: false, status: 409, reason: signal.expiration_reason || 'Signal expired' };

  const reason = await expirationReason(signal);
  if (reason) {
    await expireSignal(signal, reason);
    return { ok: false, status: 409, reason };
  }

  if (config.requireFreshReviewBeforeApproval && !signal.last_reviewed_at) {
    emitEvent('Signals', 'approval_blocked_stale', `${signal.symbol} approval blocked: fresh review required.`, { signalId: signal.id, symbol: signal.symbol }, 'warn');
    return { ok: false, status: 428, reason: 'Fresh pre-trade review required before approval.' };
  }

  const market = signal.market_type === 'crypto'
    ? await coinbaseCryptoAdapter.getTicker(signal.symbol)
    : await safeMarketRow(signal.symbol);
  const currentPrice = Number(market.price || 0);
  const signalPrice = Number(signal.signal_price || signal.entry_price || 0);
  const reviewPrice = Number(signal.review_price || signalPrice);
  const slippagePercent = Math.abs(pctMove(reviewPrice, currentPrice));
  const extensionPercent = Math.abs(pctMove(signalPrice, currentPrice));

  if (slippagePercent > config.maxEntrySlippagePercent) {
    await collections.signals.updateOne({ id: signal.id }, { $set: { stale_status: 'approval_blocked_slippage' } });
    emitEvent('Signals', 'approval_blocked_price_moved', `${signal.symbol} approval blocked: slippage ${slippagePercent.toFixed(2)}%.`, { signalId: signal.id, symbol: signal.symbol, slippagePercent }, 'warn');
    return { ok: false, status: 409, reason: 'approval blocked because price moved too far from review price', currentPrice, slippagePercent };
  }

  if (extensionPercent > config.maxExtensionFromSignalPercent) {
    await expireSignal(signal, 'price_moved_too_far');
    emitEvent('Signals', 'approval_blocked_price_moved', `${signal.symbol} approval blocked: extension ${extensionPercent.toFixed(2)}%.`, { signalId: signal.id, symbol: signal.symbol, extensionPercent }, 'warn');
    return { ok: false, status: 409, reason: 'approval blocked because price moved too far from signal price', currentPrice, extensionPercent };
  }

  await collections.signals.updateOne({ id: signal.id }, { $set: { approval_price: currentPrice, stale_status: 'approval_validated' } });
  return { ok: true, currentPrice, slippagePercent, extensionPercent };
}

export { pctMove };
