import { API_URL } from './config';

async function request(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json()
    : { error: await response.text() };

  if (!response.ok) {
    const detail = data.error || data.reason || `HTTP ${response.status}`;
    throw new Error(`API request failed for ${path}: ${detail}`);
  }

  if (!contentType.includes('application/json')) {
    throw new Error(`API request failed for ${path}: expected JSON but received ${contentType || 'unknown content type'}`);
  }

  return data;
}

export const api = {
  account: () => request('/api/account'),
  positions: () => request('/api/positions'),
  closePosition: (symbol) => request(`/api/positions/${symbol}/close`, { method: 'POST', body: JSON.stringify({ reason: 'manual_close' }) }),
  orders: () => request('/api/orders'),
  watchlist: () => request('/api/watchlist'),
  watchlists: () => request('/api/watchlists'),
  contextWatchlist: () => request('/api/watchlists/context'),
  tradingUniverse: () => request('/api/watchlists/trading-universe'),
  scannerSettings: () => request('/api/scanner/settings'),
  saveScannerSettings: (payload) => request('/api/scanner/settings', { method: 'POST', body: JSON.stringify(payload) }),
  relaxScannerSettings: () => request('/api/scanner/settings', { method: 'POST', body: JSON.stringify({ relax: true }) }),
  runScanner: (preset = '') => request(`/api/scanner/run${preset ? `?preset=${encodeURIComponent(preset)}` : ''}`, { method: 'POST', body: '{}' }),
  scannerRuns: () => request('/api/scanner/runs'),
  scannerRun: (id) => request(`/api/scanner/runs/${id}`),
  blockSymbol: (symbol) => request(`/api/watchlists/${symbol}/block`, { method: 'POST', body: '{}' }),
  unblockSymbol: (symbol) => request(`/api/watchlists/${symbol}/unblock`, { method: 'POST', body: '{}' }),
  marketRegime: () => request('/api/market-regime'),
  cryptoDashboard: () => request('/api/crypto/dashboard'),
  cryptoScannerSettings: () => request('/api/crypto/scanner/settings'),
  saveCryptoScannerSettings: (payload) => request('/api/crypto/scanner/settings', { method: 'POST', body: JSON.stringify(payload) }),
  cryptoScannerAutoStatus: () => request('/api/crypto/scanner/auto-status'),
  cryptoStrategySettings: () => request('/api/crypto/strategy-settings'),
  saveCryptoStrategySettings: (payload) => request('/api/crypto/strategy-settings', { method: 'POST', body: JSON.stringify(payload) }),
  debugCryptoSignal: (payload) => request('/api/crypto/signals/debug', { method: 'POST', body: JSON.stringify(payload) }),
  simulateCryptoSignalModes: (payload) => request('/api/crypto/signals/simulate', { method: 'POST', body: JSON.stringify(payload) }),
  nearMissAnalytics: () => request('/api/crypto/near-miss-analytics'),
  runCryptoScanner: (preset = '') => request(`/api/crypto/scanner/run${preset ? `?preset=${encodeURIComponent(preset)}` : ''}`, { method: 'POST', body: '{}' }),
  marketClock: () => request('/api/market-clock'),
  events: () => request('/api/events'),
  monitoredPositions: () => request('/api/monitored-positions'),
  monitorStatus: () => request('/api/monitor/status'),
  exitMonitoredPosition: (id) => request(`/api/monitored-positions/${id}/exit`, { method: 'POST', body: '{}' }),
  markMonitoredReviewed: (id) => request(`/api/monitored-positions/${id}/mark-reviewed`, { method: 'POST', body: '{}' }),
  signals: () => request('/api/signals'),
  signalReview: (id) => request(`/api/signals/${id}/review`),
  approveSignal: (id) => request(`/api/signals/${id}/approve`, { method: 'POST', body: '{}' }),
  rejectSignal: (id) => request(`/api/signals/${id}/reject`, { method: 'POST', body: '{}' }),
  killSwitch: (enabled = true) => request('/api/trading/kill-switch', { method: 'POST', body: JSON.stringify({ enabled }) }),
  settings: (payload) => request('/api/settings', { method: 'POST', body: JSON.stringify(payload) }),
  performance: () => request('/api/performance'),
  journal: () => request('/api/journal'),
  updateJournalNotes: (id, payload) => request(`/api/journal/${id}/notes`, { method: 'POST', body: JSON.stringify(payload) }),
  performanceSummary: () => request('/api/performance/summary'),
  performanceDaily: () => request('/api/performance/daily'),
  performanceStrategy: () => request('/api/performance/strategy'),
  performanceSymbols: () => request('/api/performance/symbols'),
  signalOutcomes: () => request('/api/signals/outcomes')
};
