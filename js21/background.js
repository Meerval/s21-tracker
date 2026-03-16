// Service Worker — handles all API requests
const BASE_URL = 'https://platform.21-school.ru/services/21-school/api';
const AUTH_URL = 'https://auth.21-school.ru/auth/realms/EduPowerKeycloak/protocol/openid-connect/token';

// Keep service worker alive
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
});
chrome.alarms.onAlarm.addListener(() => {});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg).then(sendResponse).catch(err => sendResponse({ error: err.message }));
  return true;
});

async function handleMessage(msg) {
  switch (msg.type) {

    case 'PING':
      return { ok: true };

    case 'AUTH': {
      // origin/referer headers are injected by declarativeNetRequest rules
      const resp = await fetchWithRetry(AUTH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id:  's21-open-api',
          username:   msg.username,
          password:   msg.password
        })
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Auth failed ${resp.status}: ${text}`);
      }
      return resp.json();
    }

    case 'GET': {
      const resp = await fetchWithRetry(BASE_URL + msg.path, {
        headers: { 'Authorization': 'Bearer ' + msg.token }
      });
      const ct = resp.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        // Non-JSON response (HTML error page, etc.)
        return { status: resp.status, data: null };
      }
      let data = null;
      try { data = await resp.json(); } catch(e) { data = null; }
      return { status: resp.status, data };
    }

    case 'STORAGE_GET':
      return new Promise(resolve => chrome.storage.local.get(msg.key, r => resolve(r[msg.key] ?? null)));

    case 'STORAGE_SET':
      return new Promise(resolve => chrome.storage.local.set({ [msg.key]: msg.value }, resolve));

    case 'STORAGE_REMOVE':
      return new Promise(resolve => chrome.storage.local.remove(msg.key, resolve));

    case 'STORAGE_KEYS':
      return new Promise(resolve =>
        chrome.storage.local.get(null, items =>
          resolve(Object.keys(items).filter(k => k.startsWith(msg.prefix)))
        )
      );

    default:
      throw new Error('Unknown message type: ' + msg.type);
  }
}

async function fetchWithRetry(url, opts, attempt = 0) {
  const resp = await fetch(url, opts);
  if (resp.status === 429 && attempt < 20) {
    const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
    await new Promise(r => setTimeout(r, delay));
    return fetchWithRetry(url, opts, attempt + 1);
  }
  return resp;
}
