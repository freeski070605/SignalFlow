import crypto from 'node:crypto';
import fetch from 'node-fetch';
import { config } from '../config.js';

const publicHeaders = { 'user-agent': 'SignalFlow/0.1' };

function hasCoinbaseCredentials() {
  return Boolean(config.coinbaseApiKeyName && config.coinbaseApiPrivateKey);
}

function redact(value) {
  if (!value) return '';
  return String(value).slice(0, 8);
}

function sanitizeError(error, action) {
  const message = error?.message || 'Unknown Coinbase error';
  const safeMessage = String(message)
    .replace(config.coinbaseApiPrivateKey || '__missing_private_key__', '[redacted]')
    .replace(config.coinbaseApiKeyName || '__missing_key_name__', '[redacted]');
  return new Error(`Coinbase ${action} failed: ${safeMessage}`);
}

function normalizePrivateKey(raw) {
  let value = String(raw || '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  value = value.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();
  if (value.includes('-----BEGIN')) return value;

  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8').replace(/\\n/g, '\n').trim();
    if (decoded.includes('-----BEGIN')) return decoded;
  } catch {
    // Fall through to the original value so createPrivateKey can produce the real decode error.
  }

  return value;
}

function privateKeyStatus() {
  if (!config.coinbaseApiPrivateKey) return { ok: false, status: 'missing_credentials', message: 'Coinbase private key is missing.' };
  try {
    const normalized = normalizePrivateKey(config.coinbaseApiPrivateKey);
    let key;
    try {
      key = crypto.createPrivateKey(normalized);
    } catch (error) {
      const raw = Buffer.from(normalized, 'base64');
      if (![32, 64].includes(raw.length)) throw error;
      key = crypto.createPrivateKey({
        key: {
          kty: 'OKP',
          crv: 'Ed25519',
          d: raw.subarray(0, 32).toString('base64url')
        },
        format: 'jwk'
      });
    }
    const type = key.asymmetricKeyType;
    if (!['ec', 'ed25519'].includes(type)) {
      return { ok: false, status: 'credential_error', message: `Coinbase private key type ${type || 'unknown'} is not supported.` };
    }
    return { ok: true, key, type };
  } catch {
    return {
      ok: false,
      status: 'credential_error',
      message: 'Coinbase private key could not be decoded. Put the full PEM on one .env line with literal \\n between lines, or wrap the quoted multiline value correctly.'
    };
  }
}

function credentialStatus() {
  if (!config.coinbaseApiKeyName || !config.coinbaseApiPrivateKey) {
    return { ok: false, status: 'missing_credentials', message: 'Coinbase credentials are missing.' };
  }
  const keyStatus = privateKeyStatus();
  if (!keyStatus.ok) return keyStatus;
  return { ok: true, status: 'configured', key: keyStatus.key, keyType: keyStatus.type };
}

function jwt(method, path) {
  if (!hasCoinbaseCredentials()) return null;
  const credentials = credentialStatus();
  if (!credentials.ok) throw new Error(credentials.message);
  const now = Math.floor(Date.now() / 1000);
  const base = new URL(config.coinbaseApiBaseUrl);
  const requestPath = `${base.pathname.replace(/\/$/, '')}${path}`;
  const alg = credentials.keyType === 'ed25519' ? 'EdDSA' : 'ES256';
  const header = { alg, kid: config.coinbaseApiKeyName, nonce: crypto.randomBytes(16).toString('hex'), typ: 'JWT' };
  const payload = {
    iss: 'cdp',
    sub: config.coinbaseApiKeyName,
    nbf: now,
    exp: now + 120,
    uri: `${method.toUpperCase()} ${base.host}${requestPath}`
  };
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${enc(header)}.${enc(payload)}`;
  const signature = credentials.keyType === 'ed25519'
    ? crypto.sign(null, Buffer.from(body), credentials.key).toString('base64url')
    : crypto.sign('sha256', Buffer.from(body), { key: credentials.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${body}.${signature}`;
}

async function coinbaseRequest(path, { method = 'GET', body = null, auth = true } = {}) {
  try {
    if (auth && !hasCoinbaseCredentials()) {
      return { missing_credentials: true, message: 'Coinbase credentials are missing.' };
    }
    const token = auth ? jwt(method, path) : null;
    const response = await fetch(`${config.coinbaseApiBaseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const coinbaseMessage = data?.message || data?.error_details || data?.error || response.statusText;
      const authHint = response.status === 401
        ? 'Unauthorized. Check that COINBASE_API_KEY_NAME exactly matches the Coinbase key name, the key has Advanced Trade view permission for accounts, it belongs to the same Coinbase account/portfolio, and your computer clock is correct.'
        : '';
      throw new Error([coinbaseMessage, authHint].filter(Boolean).join(' '));
    }
    return data;
  } catch (error) {
    throw sanitizeError(error, `${method} ${path}`);
  }
}

async function publicRequest(path) {
  const response = await fetch(`${config.coinbasePublicBaseUrl}${path}`, { headers: publicHeaders });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || response.statusText);
  return data;
}

function candleGranularity(timeframe) {
  if (timeframe === '1m') return 60;
  if (timeframe === '15m') return 900;
  if (timeframe === '1h') return 3600;
  return 300;
}

export const cryptoUniverse = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'LINK-USD', 'AVAX-USD', 'ADA-USD', 'DOGE-USD', 'XRP-USD', 'LTC-USD', 'BCH-USD'];
export const cryptoMajors = ['BTC-USD', 'ETH-USD', 'SOL-USD'];

export const coinbaseCryptoAdapter = {
  name: 'coinbase',
  marketType: 'crypto',
  getAccount: async () => {
    const credentials = credentialStatus();
    if (!credentials.ok) return { status: credentials.status, message: credentials.message, trading_blocked: true, exchange: 'coinbase', marketType: 'crypto', keyHint: redact(config.coinbaseApiKeyName) };
    const balances = await coinbaseRequest('/accounts');
    return { status: 'CONNECTED', exchange: 'coinbase', marketType: 'crypto', raw: balances };
  },
  getBalances: async () => {
    const credentials = credentialStatus();
    if (!credentials.ok) return [];
    const data = await coinbaseRequest('/accounts');
    return (data.accounts || []).map((row) => ({
      asset: row.currency,
      available: Number(row.available_balance?.value || 0),
      hold: Number(row.hold?.value || 0),
      raw: row
    }));
  },
  getTradableAssets: async () => cryptoUniverse,
  getProducts: async () => {
    const products = await publicRequest('/products');
    return products.filter((product) => product.quote_currency === 'USD');
  },
  getTicker: async (symbol) => {
    const product = symbol.toUpperCase();
    const ticker = await publicRequest(`/products/${product}/ticker`);
    const book = await publicRequest(`/products/${product}/book?level=1`).catch(() => ({ bids: [], asks: [] }));
    const bid = Number(book.bids?.[0]?.[0] || ticker.bid || 0);
    const ask = Number(book.asks?.[0]?.[0] || ticker.ask || 0);
    const mid = bid && ask ? (bid + ask) / 2 : Number(ticker.price || 0);
    return {
      symbol: product,
      price: Number(ticker.price || mid || 0),
      bid,
      ask,
      spreadPercent: mid ? ((ask - bid) / mid) * 100 : 0,
      volume24h: Number(ticker.volume || 0) * Number(ticker.price || mid || 0),
      raw: ticker
    };
  },
  getCandles: async (symbol, timeframe = '5m', options = {}) => {
    const granularity = candleGranularity(timeframe);
    const limit = Math.min(300, Math.max(1, Number(options.limit || 180)));
    const end = options.end ? Math.floor(new Date(options.end).getTime() / 1000) : Math.floor(Date.now() / 1000);
    const requestedStart = options.start ? Math.floor(new Date(options.start).getTime() / 1000) : end - granularity * limit;
    const start = Math.max(requestedStart, end - granularity * limit);
    const rows = await publicRequest(`/products/${symbol.toUpperCase()}/candles?granularity=${granularity}&start=${start}&end=${end}`);
    return rows.map(([time, low, high, open, close, volume]) => ({
      timestamp: new Date(time * 1000).toISOString(),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume)
    })).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  },
  getOrderBook: async (symbol) => publicRequest(`/products/${symbol.toUpperCase()}/book?level=1`),
  getOpenPositions: async () => {
    const balances = await coinbaseCryptoAdapter.getBalances();
    return balances.filter((row) => row.asset !== 'USD' && Number(row.available || 0) > 0).map((row) => ({
      symbol: `${row.asset}-USD`,
      base_asset: row.asset,
      quote_asset: 'USD',
      qty: row.available,
      market_type: 'crypto',
      exchange: 'coinbase'
    }));
  },
  getOpenOrders: async () => {
    const credentials = credentialStatus();
    if (!credentials.ok) return [];
    const data = await coinbaseRequest('/orders/historical/batch?order_status=OPEN');
    return data.orders || [];
  },
  submitOrder: async ({ symbol, side, notional, qty }) => {
    if (!config.cryptoTradingEnabled) throw new Error('Crypto trading is disabled.');
    const credentials = credentialStatus();
    if (!credentials.ok) throw new Error(credentials.message);
    const clientOrderId = crypto.randomUUID();
    const order = {
      client_order_id: clientOrderId,
      product_id: symbol.toUpperCase(),
      side: side.toUpperCase(),
      order_configuration: {
        market_market_ioc: side === 'buy'
          ? { quote_size: Number(notional).toFixed(2) }
          : { base_size: Number(qty).toFixed(8) }
      }
    };
    return coinbaseRequest('/orders', { method: 'POST', body: order });
  },
  cancelOrder: async (orderId) => coinbaseRequest('/orders/batch_cancel', { method: 'POST', body: { order_ids: [orderId] } }),
  closePosition: async (symbol) => {
    const [base] = symbol.split('-');
    const balances = await coinbaseCryptoAdapter.getBalances();
    const balance = balances.find((row) => row.asset === base);
    if (!balance || Number(balance.available) <= 0) throw new Error(`No open ${symbol} position found.`);
    return coinbaseCryptoAdapter.submitOrder({ symbol, side: 'sell', qty: balance.available });
  },
  subscribeMarketData: () => null,
  subscribeOrderUpdates: () => null,
  normalizeSymbol: (symbol) => symbol.toUpperCase().replace('/', '-'),
  formatSymbol: (symbol) => symbol.toUpperCase().replace('/', '-'),
  hasCredentials: hasCoinbaseCredentials,
  credentialStatus
};
