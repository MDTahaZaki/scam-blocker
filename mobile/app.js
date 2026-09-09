// Mobile PWA logic: paste-and-check + Web Share Target handling, backed by
// the same heuristics engine and Firebase callables (`getBlocklist`,
// `reportUrl`) as the browser extension. See extension/background.js for
// the equivalent desktop-side flow this mirrors.

// ---- Configuration ------------------------------------------------------
// Replace with your hosted dashboard URL (same value as popup.js's
// DASHBOARD_URL).
const DASHBOARD_URL = 'https://YOUR_PROJECT_ID.web.app/dashboard/index.html';

const SENSITIVITY = 2; // no settings UI on mobile yet — fixed at "balanced".
const BLOCKLIST_CACHE_KEY = 'sb_blocklist_cache';
const BLOCKLIST_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---- DOM ------------------------------------------------------------------

const urlInput = document.getElementById('url-input');
const checkBtn = document.getElementById('check-btn');
const resultSection = document.getElementById('result-section');
const resultBadge = document.getElementById('result-badge');
const badgeLabel = document.getElementById('badge-label');
const resultUrlEl = document.getElementById('result-url');
const reasonsList = document.getElementById('reasons-list');
const reportBtn = document.getElementById('report-btn');
const reportMessage = document.getElementById('report-message');
const firebaseWarning = document.getElementById('firebase-warning');
const errorMessage = document.getElementById('error-message');
const dashboardLink = document.getElementById('dashboard-link');

dashboardLink.href = DASHBOARD_URL;

let lastCheckedUrl = null;
let lastVerdict = null; // 'safe' | 'suspicious' | 'dangerous'

// ---- Firebase init (compat SDK, loaded via CDN in index.html) ------------
// Same degrade-gracefully pattern as extension/background.js: an empty
// apiKey in firebase-config.js runs everything in local-only mode instead
// of throwing.

let firebaseReady = false;
let auth = null;
let cloudFunctions = null;

try {
  if (typeof firebaseConfig !== 'undefined' && firebaseConfig && firebaseConfig.apiKey) {
    firebase.initializeApp(firebaseConfig);
    auth = firebase.auth();
    cloudFunctions = firebase.functions();
    firebaseReady = true;
  } else {
    firebaseWarning.hidden = false;
  }
} catch (err) {
  console.warn('[SafeLink] Firebase init failed — running in local-only mode:', err && err.message);
  firebaseWarning.hidden = false;
}

// Resolves once Firebase Auth's initial state is known, signing in
// anonymously if no session exists yet — mirrors ensureSignedIn() in
// extension/background.js so reportUrl can attribute reports to a stable uid.
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
    console.warn('[SafeLink] Anonymous sign-in failed:', err && err.message);
    return null;
  }
}

// ---- Blocklist (cached in localStorage for 1 hour) ------------------------

function readBlocklistCache() {
  try {
    const raw = localStorage.getItem(BLOCKLIST_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached || !Array.isArray(cached.urls)) return null;
    if (Date.now() - cached.fetchedAt >= BLOCKLIST_CACHE_TTL_MS) return null;
    return cached.urls;
  } catch {
    return null;
  }
}

function writeBlocklistCache(urls) {
  try {
    localStorage.setItem(BLOCKLIST_CACHE_KEY, JSON.stringify({ urls, fetchedAt: Date.now() }));
  } catch {
    // localStorage unavailable (private mode, quota) — cache is best-effort.
  }
}

async function getBlocklist() {
  const cached = readBlocklistCache();
  if (cached) return cached;

  if (!firebaseReady) return [];

  try {
    await ensureSignedIn();
    const getBlocklistCallable = cloudFunctions.httpsCallable('getBlocklist');
    const result = await getBlocklistCallable();
    const urls = Array.isArray(result.data) ? result.data : [];
    writeBlocklistCache(urls);
    return urls;
  } catch (err) {
    console.warn('[SafeLink] Failed to fetch blocklist:', err && err.message);
    // Fall back to a stale cache rather than nothing, if one exists.
    try {
      const raw = localStorage.getItem(BLOCKLIST_CACHE_KEY);
      const cached2 = raw && JSON.parse(raw);
      return (cached2 && cached2.urls) || [];
    } catch {
      return [];
    }
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
    return hostname === normalized || hostname.endsWith(`.${normalized}`) || lowerUrl.includes(normalized);
  });
}

// ---- URL parsing helpers --------------------------------------------------

// Normalizes user input into something `new URL()` can parse: adds a
// scheme if one is missing (e.g. "example.com/login" -> "https://example.com/login").
function normalizeUrl(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

// Some apps share a URL only inside `text`/`title`, not `url`. Pull the
// first http(s) URL out of a blob of text as a fallback.
function extractUrlFromText(text) {
  if (!text) return '';
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : '';
}

// ---- Check flow -------------------------------------------------------

function resetResult() {
  resultSection.hidden = true;
  reasonsList.hidden = true;
  reasonsList.innerHTML = '';
  reportBtn.disabled = true;
  reportMessage.hidden = true;
  errorMessage.hidden = true;
  lastCheckedUrl = null;
  lastVerdict = null;
}

function renderResult(url, verdict, reasons) {
  lastCheckedUrl = url;
  lastVerdict = verdict;

  resultSection.hidden = false;
  resultUrlEl.textContent = url;

  resultBadge.classList.remove('badge--safe', 'badge--suspicious', 'badge--dangerous');
  reasonsList.innerHTML = '';
  reasonsList.hidden = true;

  if (verdict === 'dangerous') {
    resultBadge.classList.add('badge--dangerous');
    badgeLabel.textContent = 'Dangerous';
  } else if (verdict === 'suspicious') {
    resultBadge.classList.add('badge--suspicious');
    badgeLabel.textContent = 'Suspicious';
  } else {
    resultBadge.classList.add('badge--safe');
    badgeLabel.textContent = 'Safe';
  }

  if (reasons && reasons.length) {
    reasonsList.hidden = false;
    reasons.forEach((reason) => {
      const li = document.createElement('li');
      li.textContent = reason;
      reasonsList.appendChild(li);
    });
  }

  reportBtn.disabled = verdict === 'safe';
  reportMessage.hidden = true;
}

async function checkUrlValue(rawInput) {
  errorMessage.hidden = true;
  const normalized = normalizeUrl(rawInput);

  if (!normalized) {
    errorMessage.textContent = 'Enter a URL to check.';
    errorMessage.hidden = false;
    return;
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    errorMessage.textContent = 'That doesn\'t look like a valid URL.';
    errorMessage.hidden = false;
    return;
  }

  checkBtn.disabled = true;
  checkBtn.textContent = 'Checking…';

  try {
    const [blocklist, heuristics] = await Promise.all([
      getBlocklist(),
      Promise.resolve(HeuristicsUtil.checkUrl(parsed.href, SENSITIVITY))
    ]);

    const inBlocklist = matchesBlocklist(parsed.href, blocklist);
    const reasons = [...heuristics.reasons];
    if (inBlocklist) reasons.unshift('URL matches known scam blocklist');

    let verdict = 'safe';
    if (inBlocklist || heuristics.isScam) {
      verdict = 'dangerous';
    } else if (reasons.length > 0) {
      // Flagged by at least one weak signal but not enough to cross the
      // heuristics threshold — surfaced as a middle "suspicious" tier
      // rather than silently calling it safe.
      verdict = 'suspicious';
    }

    renderResult(parsed.href, verdict, reasons);
  } finally {
    checkBtn.disabled = false;
    checkBtn.textContent = 'Check Link';
  }
}

checkBtn.addEventListener('click', () => {
  resetResult();
  checkUrlValue(urlInput.value);
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    resetResult();
    checkUrlValue(urlInput.value);
  }
});

// ---- Report as Scam ---------------------------------------------------

async function reportCurrentUrl() {
  if (!lastCheckedUrl) return;

  if (!firebaseReady) {
    reportMessage.textContent = 'Firebase is not configured — reporting is disabled.';
    reportMessage.classList.add('error');
    reportMessage.hidden = false;
    return;
  }

  reportBtn.disabled = true;
  reportMessage.classList.remove('error');
  reportMessage.textContent = 'Submitting report…';
  reportMessage.hidden = false;

  try {
    const user = await ensureSignedIn();
    if (!user) throw new Error('Could not authenticate with Firebase.');

    const reportUrlCallable = cloudFunctions.httpsCallable('reportUrl');
    const result = await reportUrlCallable({ url: lastCheckedUrl });

    cloudFunctions
      .httpsCallable('incrementScan')({ isReport: true })
      .catch(() => {});

    reportMessage.textContent = (result.data && result.data.message) || 'Thanks! This link has been reported.';
    reportMessage.classList.remove('error');
  } catch (err) {
    reportMessage.textContent = (err && err.message) || 'Could not submit report. Please try again later.';
    reportMessage.classList.add('error');
  } finally {
    reportBtn.disabled = lastVerdict === 'safe';
    reportMessage.hidden = false;
  }
}

reportBtn.addEventListener('click', reportCurrentUrl);

// ---- Share Target / query-param entry point ----------------------------
// Android's Web Share Target (see manifest.webmanifest's `share_target`)
// opens this page with ?title=&text=&url= from whatever app the user
// shared from. Prefer `url`, fall back to a URL embedded in `text`.

function getSharedUrl() {
  const params = new URLSearchParams(window.location.search);
  const directUrl = params.get('url');
  if (directUrl) return directUrl;

  const text = params.get('text');
  const fromText = extractUrlFromText(text);
  if (fromText) return fromText;

  const title = params.get('title');
  return extractUrlFromText(title);
}

// ---- Service worker registration ---------------------------------------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('[SafeLink] Service worker registration failed:', err && err.message);
    });
  });
}

// ---- Startup ------------------------------------------------------------

(function init() {
  const shared = getSharedUrl();
  if (shared) {
    urlInput.value = shared;
    checkUrlValue(shared);
  }
})();
