import crypto from 'node:crypto';
import { config } from './config.js';
import { coinbaseCryptoAdapter } from './adapters/coinbaseCryptoAdapter.js';

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
    // Keep original value for diagnostics below.
  }

  return value;
}

function keyMetadata() {
  if (!config.coinbaseApiPrivateKey) return { present: false };
  try {
    const key = crypto.createPrivateKey(normalizePrivateKey(config.coinbaseApiPrivateKey));
    return {
      present: true,
      decodes: true,
      type: key.asymmetricKeyType,
      curve: key.asymmetricKeyDetails?.namedCurve || null
    };
  } catch {
    return { present: true, decodes: false };
  }
}

async function publicConnectivity() {
  try {
    const response = await fetch(`${config.coinbasePublicBaseUrl}/products/BTC-USD/ticker`);
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function keyNameMetadata() {
  const value = config.coinbaseApiKeyName || '';
  const resourceName = /^organizations\/[^/]+\/apiKeys\/[^/]+$/.test(value);
  return {
    present: Boolean(value),
    length: value.length,
    prefix: value ? value.slice(0, 14) : '',
    resourceName,
    hint: resourceName ? 'looks_like_full_resource_name' : 'expected organizations/{org_id}/apiKeys/{key_id}'
  };
}

async function authenticatedAccounts() {
  try {
    const account = await coinbaseCryptoAdapter.getAccount();
    return {
      ok: account.status === 'CONNECTED',
      status: account.status,
      accountCount: account.raw?.accounts?.length || 0
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

const report = {
  coinbaseApiBaseUrl: config.coinbaseApiBaseUrl,
  coinbasePublicBaseUrl: config.coinbasePublicBaseUrl,
  computerTimeUtc: new Date().toISOString(),
  apiKeyName: keyNameMetadata(),
  privateKey: keyMetadata(),
  credentialStatus: (() => {
    const status = coinbaseCryptoAdapter.credentialStatus();
    return { ok: status.ok, status: status.status, keyType: status.keyType || null, message: status.message || null };
  })(),
  publicConnectivity: await publicConnectivity(),
  authenticatedAccounts: await authenticatedAccounts()
};

console.log(JSON.stringify(report, null, 2));
