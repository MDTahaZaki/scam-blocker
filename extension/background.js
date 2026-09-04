// Service worker: navigation gate + blocklist sync.
importScripts('utils/heuristics.js');

// ---- Configuration ---------------------------------------------------
// Replace with your deployed Cloud Functions base URL, e.g.
// https://us-central1-your-project-id.cloudfunctions.net
const FUNCTIONS_BASE_URL = 'https://REGION-YOUR_PROJECT_ID.cloudfunctions.net';

const GET_BLOCKLIST_URL = `${FUNCTIONS_BASE_URL}/getBlocklist`;
const INCREMENT_SCAN_URL = `${FUNCTIONS_BASE_URL}/incrementScan`;

const BLOCKLIST_ALARM_NAME = 'refresh-blocklist';
const BLOCKLIST_REFRESH_MINUTES = 60;
const BLOCKLIST_STORAGE_KEY = 'blocklist';
const BLOCKPAGE_PATH = 'blockpage/block.html';

// Per-tab last-known status, used by the popup. Cleared when the tab closes.
const tabStatus = new Map();

// ---- Blocklist sync ----------------------------------------------------

async function refreshBlocklist() {
  try {
    const res = await fetch(GET_BLOCKLIST_URL);
    if (!res.ok) throw new Error(`getBlocklist returned ${res.status}`);
    const data = await res.json();
    const urls = Array.isArray(data.blocklist) ? data.blocklist : [];
    await chrome.storage.local.set({
      [BLOCKLIST_STORAGE_KEY]: urls,
      blocklistUpdatedAt: Date.now()
    });
  } catch (err) {
    console.warn('[ScamBlocker] Failed to refresh blocklist:', err && err.message);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(BLOCKLIST_ALARM_NAME, { periodInMinutes: BLOCKLIST_REFRESH_MINUTES });
  refreshBlocklist();
});

chrome.runtime.onStartup.addListener(() => {
  refreshBlocklist();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BLOCKLIST_ALARM_NAME) {
    refreshBlocklist();
  }
});

// ---- URL evaluation ------------------------------------------------------

function isExtensionOrInternalUrl(url) {
  return /^(chrome|chrome-extension|edge|about|devtools|file):/i.test(url);
}

async function getStoredBlocklist() {
  const { [BLOCKLIST_STORAGE_KEY]: blocklist = [] } = await chrome.storage.local.get(BLOCKLIST_STORAGE_KEY);
  return blocklist;
}

function matchesBlocklist(url, blocklist) {
  let hostname = '';
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const lowerUrl = url.toLowerCase();
  return blocklist.some((entry) => {
    const normalized = String(entry).toLowerCase().trim();
    if (!normalized) return false;
    return (
      hostname === normalized ||
      hostname.endsWith(`.${normalized}`) ||
      lowerUrl.includes(normalized)
    );
  });
}

async function evaluateUrl(url) {
  const blocklist = await getStoredBlocklist();
  const inBlocklist = matchesBlocklist(url, blocklist);
  const heuristics = HeuristicsUtil.checkUrl(url);

  const reasons = [...heuristics.reasons];
  if (inBlocklist) reasons.unshift('URL matches known scam blocklist');

  return {
    isDangerous: inBlocklist || heuristics.isScam,
    reasons
  };
}

function reportScan(url, isDangerous) {
  fetch(INCREMENT_SCAN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, isDangerous })
  }).catch(() => {
    // Stats reporting is best-effort; ignore failures.
  });
}

function redirectToBlockPage(tabId, url, reasons) {
  const blockUrl = chrome.runtime.getURL(
    `${BLOCKPAGE_PATH}?url=${encodeURIComponent(url)}&reasons=${encodeURIComponent(JSON.stringify(reasons))}`
  );
  chrome.tabs.update(tabId, { url: blockUrl });
}

// ---- Navigation gate ------------------------------------------------------

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return; // main frame only
  const { url, tabId } = details;

  if (isExtensionOrInternalUrl(url)) return;

  const { isDangerous, reasons } = await evaluateUrl(url);
  tabStatus.set(tabId, { url, isDangerous, reasons, checkedAt: Date.now() });
  reportScan(url, isDangerous);

  if (isDangerous) {
    redirectToBlockPage(tabId, url, reasons);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStatus.delete(tabId);
});

// ---- Messaging (content script + popup) ------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return undefined;

  if (message.type === 'PAGE_CHECK') {
    // SPA / client-side navigation reported by content.js.
    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId !== 'number') return undefined;

    evaluateUrl(message.url).then(({ isDangerous, reasons }) => {
      tabStatus.set(tabId, { url: message.url, isDangerous, reasons, checkedAt: Date.now() });
      if (isDangerous) {
        redirectToBlockPage(tabId, message.url, reasons);
      }
    });
    return undefined;
  }

  if (message.type === 'GET_TAB_STATUS') {
    const tabId = message.tabId;
    const cached = tabStatus.get(tabId);
    if (cached) {
      sendResponse(cached);
      return undefined;
    }
    if (!message.url || isExtensionOrInternalUrl(message.url)) {
      sendResponse({ url: message.url, isDangerous: false, reasons: [], unknown: true });
      return undefined;
    }
    evaluateUrl(message.url).then(({ isDangerous, reasons }) => {
      sendResponse({ url: message.url, isDangerous, reasons, checkedAt: Date.now() });
    });
    return true; // keep the message channel open for the async sendResponse
  }

  return undefined;
});
