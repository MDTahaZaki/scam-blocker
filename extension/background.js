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
  if (!firebaseReady) return;
  ensureSignedIn()
    .then(() => cloudFunctions.httpsCallable('incrementScan')({ url, isDangerous }))
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

  return undefined;
});
