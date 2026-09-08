// Service worker: navigation gate + Firebase-backed blocklist sync/reporting.
//
// IMPORTANT (Manifest V3 remote-code caveat): Chrome Web Store policy
// prohibits published extensions from executing remotely-hosted code. The
// importScripts() calls below pull the Firebase "compat" SDK from Google's
// CDN, which works for local/unpacked development and testing (and requires
// the content_security_policy override in manifest.json), but a Web Store
// submission would need these files vendored locally instead (e.g. under
// extension/vendor/firebase/) with the importScripts() paths below updated
// to match and the CSP override removed. Everything here degrades
// gracefully if the SDK fails to load or firebase-config.js is left with an
// empty apiKey: the extension falls back to local heuristics plus whatever
// blocklist is already cached.

importScripts('utils/heuristics.js');

let firebaseReady = false;
let auth = null;
let cloudFunctions = null;

try {
  importScripts(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions-compat.js',
    'firebase-config.js'
  );

  if (firebaseConfig && firebaseConfig.apiKey) {
    firebase.initializeApp(firebaseConfig);
    auth = firebase.auth();
    cloudFunctions = firebase.functions();
    firebaseReady = true;
  } else {
    console.warn(
      '[ScamBlocker] firebase-config.js has no apiKey set — running in local-only mode ' +
        '(heuristics + last cached blocklist; sync and reporting are disabled).'
    );
  }
} catch (err) {
  console.warn('[ScamBlocker] Firebase SDK failed to load — running in local-only mode:', err && err.message);
}

// Resolves once Firebase Auth's initial state is known, signing in
// anonymously if no session was restored (e.g. first run, or a service
// worker that lost its previous in-memory state).
async function ensureSignedIn() {
  if (!firebaseReady) return null;
  try {
    const existingUser = await new Promise((resolve) => {
      const unsubscribe = auth.onAuthStateChanged((user) => {
        unsubscribe();
        resolve(user);
      });
    });
    if (existingUser) return existingUser;

    const credential = await auth.signInAnonymously();
    return credential.user;
  } catch (err) {
    console.warn('[ScamBlocker] Anonymous sign-in failed:', err && err.message);
    return null;
  }
}

// ---- Configuration ---------------------------------------------------

const BLOCKLIST_ALARM_NAME = 'refresh-blocklist';
const BLOCKLIST_REFRESH_MINUTES = 60;
const BLOCKLIST_STORAGE_KEY = 'blocklist';
const BLOCKPAGE_PATH = 'blockpage/block.html';

const SAFE_BROWSING_CACHE_KEY = 'safeBrowsingCache';
const SAFE_BROWSING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SAFE_BROWSING_THREAT_TYPES = [
  'MALWARE',
  'SOCIAL_ENGINEERING',
  'UNWANTED_SOFTWARE',
  'POTENTIALLY_HARMFUL_APPLICATION'
];

const TEMP_WHITELIST_KEY = 'temporaryWhitelist';
const TEMP_WHITELIST_DURATION_MS = 24 * 60 * 60 * 1000;

const SETTINGS_DEFAULTS = {
  safeBrowsingEnabled: false,
  safeBrowsingApiKey: '',
  sensitivity: 2
};

// Per-tab last-known status, used by the popup. Cleared when the tab closes.
const tabStatus = new Map();

// ---- Blocklist sync ----------------------------------------------------

async function syncBlocklist() {
  if (!firebaseReady) return;
  try {
    await ensureSignedIn();
    const getBlocklist = cloudFunctions.httpsCallable('getBlocklist');
    const result = await getBlocklist();
    const urls = Array.isArray(result.data) ? result.data : [];
    await chrome.storage.local.set({
      [BLOCKLIST_STORAGE_KEY]: urls,
      blocklistUpdatedAt: Date.now()
    });
  } catch (err) {
    console.warn('[ScamBlocker] Failed to sync blocklist:', err && err.message);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(BLOCKLIST_ALARM_NAME, { periodInMinutes: BLOCKLIST_REFRESH_MINUTES });
  ensureSignedIn().then(syncBlocklist);
});

chrome.runtime.onStartup.addListener(() => {
  ensureSignedIn().then(syncBlocklist);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BLOCKLIST_ALARM_NAME) {
    syncBlocklist();
  }
});

// ---- URL evaluation ------------------------------------------------------

function isExtensionOrInternalUrl(url) {
  return /^(chrome|chrome-extension|edge|about|devtools|file):/i.test(url);
}

function safeHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

async function getStoredBlocklist() {
  const { [BLOCKLIST_STORAGE_KEY]: blocklist = [] } = await chrome.storage.local.get(BLOCKLIST_STORAGE_KEY);
  return blocklist;
}

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(SETTINGS_DEFAULTS));
  return { ...SETTINGS_DEFAULTS, ...stored };
}

// ---- Temporary whitelist ("Proceed anyway" from the block page) ------

async function getTemporaryWhitelist() {
  const { [TEMP_WHITELIST_KEY]: entries = [] } = await chrome.storage.local.get(TEMP_WHITELIST_KEY);
  const now = Date.now();
  const valid = entries.filter((entry) => entry && entry.expiresAt > now);
  if (valid.length !== entries.length) {
    await chrome.storage.local.set({ [TEMP_WHITELIST_KEY]: valid });
  }
  return valid;
}

function isTemporarilyWhitelisted(hostname, whitelist) {
  return whitelist.some((entry) => entry.hostname === hostname);
}

async function addToTemporaryWhitelist(hostname) {
  const whitelist = await getTemporaryWhitelist();
  const filtered = whitelist.filter((entry) => entry.hostname !== hostname);
  filtered.push({ hostname, expiresAt: Date.now() + TEMP_WHITELIST_DURATION_MS });
  await chrome.storage.local.set({ [TEMP_WHITELIST_KEY]: filtered });
}

// ---- Google Safe Browsing (Lookup API v4) -----------------------------

async function getSafeBrowsingCache() {
  const { [SAFE_BROWSING_CACHE_KEY]: cache = {} } = await chrome.storage.local.get(SAFE_BROWSING_CACHE_KEY);
  return cache;
}

async function setSafeBrowsingCacheEntry(url, isThreat) {
  const cache = await getSafeBrowsingCache();
  const now = Date.now();
  cache[url] = { isThreat, checkedAt: now };

  // Prune expired entries so the cache doesn't grow unbounded.
  for (const key of Object.keys(cache)) {
    if (now - cache[key].checkedAt >= SAFE_BROWSING_CACHE_TTL_MS) {
      delete cache[key];
    }
  }

  await chrome.storage.local.set({ [SAFE_BROWSING_CACHE_KEY]: cache });
}

// Looks up a single URL against Google Safe Browsing. Never throws: any
// misconfiguration or network failure resolves to `{ checked: false }` so
// callers can silently fall back to heuristics-only detection.
async function checkWithSafeBrowsing(url, apiKey) {
  if (!apiKey) return { checked: false, isThreat: false };

  const cache = await getSafeBrowsingCache();
  const cached = cache[url];
  if (cached && Date.now() - cached.checkedAt < SAFE_BROWSING_CACHE_TTL_MS) {
    return { checked: true, isThreat: cached.isThreat, fromCache: true };
  }

  try {
    const response = await fetch(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client: { clientId: 'scam-link-detector-extension', clientVersion: '1.0.0' },
          threatInfo: {
            threatTypes: SAFE_BROWSING_THREAT_TYPES,
            platformTypes: ['ANY_PLATFORM'],
            threatEntryTypes: ['URL'],
            threatEntries: [{ url }]
          }
        })
      }
    );

    if (!response.ok) {
      console.warn('[ScamBlocker] Safe Browsing API returned an error:', response.status);
      return { checked: false, isThreat: false };
    }

    const data = await response.json();
    const isThreat = Array.isArray(data.matches) && data.matches.length > 0;
    await setSafeBrowsingCacheEntry(url, isThreat);

    return { checked: true, isThreat };
  } catch (err) {
    console.warn('[ScamBlocker] Safe Browsing request failed:', err && err.message);
    return { checked: false, isThreat: false };
  }
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
  const settings = await getSettings();

  const hostname = safeHostname(url);
  if (hostname) {
    const whitelist = await getTemporaryWhitelist();
    if (isTemporarilyWhitelisted(hostname, whitelist)) {
      return { isDangerous: false, reasons: [], whitelisted: true };
    }
  }

  const blocklist = await getStoredBlocklist();
  const inBlocklist = matchesBlocklist(url, blocklist);
  const heuristics = HeuristicsUtil.checkUrl(url, settings.sensitivity);

  const reasons = [...heuristics.reasons];
  if (inBlocklist) reasons.unshift('URL matches known scam blocklist');

  let isDangerous = inBlocklist || heuristics.isScam;

  // Safe Browsing is an extra, optional cloud check: only spend a lookup
  // (and API quota) on URLs local detection didn't already flag.
  if (!isDangerous && settings.safeBrowsingEnabled && settings.safeBrowsingApiKey) {
    const sb = await checkWithSafeBrowsing(url, settings.safeBrowsingApiKey);
    if (sb.checked && sb.isThreat) {
      isDangerous = true;
      reasons.push('Google Safe Browsing flagged this site');
    }
  }

  return { isDangerous, reasons };
}

function reportScan(url, isScam) {
  if (!firebaseReady) return;
  ensureSignedIn()
    .then(() => cloudFunctions.httpsCallable('incrementScan')({ isScam }))
    .catch(() => {
      // Stats reporting is best-effort; ignore failures.
    });
}

function redirectToBlockPage(tabId, url, reasons) {
  const blockUrl = chrome.runtime.getURL(
    `${BLOCKPAGE_PATH}?url=${encodeURIComponent(url)}&reasons=${encodeURIComponent(JSON.stringify(reasons))}`
  );
  chrome.tabs.update(tabId, { url: blockUrl });
}

// ---- Community reporting (popup) ------------------------------------

async function reportUrlToFirebase(url) {
  if (!firebaseReady) {
    return {
      success: false,
      error: 'Firebase is not configured. Add your project config to extension/firebase-config.js.'
    };
  }

  try {
    const user = await ensureSignedIn();
    if (!user) throw new Error('Could not authenticate with Firebase.');

    const reportUrl = cloudFunctions.httpsCallable('reportUrl');
    const result = await reportUrl({ url });

    // Best-effort stats bump. Done here rather than in popup.js so that
    // background.js remains the only place that loads the Firebase SDK
    // (see the MV3 remote-code note at the top of this file); popup.js
    // already delegates reporting to background.js via REPORT_URL, so this
    // fires for every successful report regardless of which UI triggered it.
    cloudFunctions
      .httpsCallable('incrementScan')({ isReport: true })
      .catch(() => {});

    return { success: true, message: (result.data && result.data.message) || 'Reported successfully.' };
  } catch (err) {
    return { success: false, error: (err && err.message) || 'Failed to report URL.' };
  }
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

  if (message.type === 'REPORT_URL') {
    reportUrlToFirebase(message.url).then(sendResponse);
    return true; // keep the message channel open for the async sendResponse
  }

  if (message.type === 'PROCEED_ANYWAY') {
    // Sent from the block page's "Proceed anyway" button: whitelists the
    // domain locally for 24h so the next navigation isn't re-blocked.
    const hostname = safeHostname(message.url || '');
    if (!hostname) {
      sendResponse({ success: false, error: 'Invalid URL.' });
      return undefined;
    }
    addToTemporaryWhitelist(hostname).then(() => {
      const tabId = sender.tab && sender.tab.id;
      if (typeof tabId === 'number') tabStatus.delete(tabId);
      sendResponse({ success: true });
    });
    return true; // keep the message channel open for the async sendResponse
  }

  return undefined;
});
