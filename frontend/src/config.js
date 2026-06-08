const trimTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

export const API_URL = trimTrailingSlash(import.meta.env.VITE_API_URL || 'http://localhost:4000');

function deriveWsUrl(apiUrl) {
  if (!apiUrl) return 'ws://localhost:4000';

  try {
    const url = new URL(apiUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return trimTrailingSlash(url.toString());
  } catch {
    return 'ws://localhost:4000';
  }
}

function normalizeWsUrl(wsUrl, apiUrl) {
  const explicitUrl = trimTrailingSlash(wsUrl);
  const candidate = explicitUrl || deriveWsUrl(apiUrl);

  try {
    const url = new URL(candidate);
    if (window.location.protocol === 'https:' && url.protocol === 'ws:') {
      url.protocol = 'wss:';
    }
    return trimTrailingSlash(url.toString());
  } catch {
    return deriveWsUrl(apiUrl);
  }
}

export const WS_URL = normalizeWsUrl(import.meta.env.VITE_WS_URL, API_URL);
