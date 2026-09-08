// ---- Configuration ---------------------------------------------------
// Replace with your hosted dashboard URL.
//
// Reporting is delegated to background.js via chrome.runtime.sendMessage
// rather than loading the Firebase SDK a second time here: background.js
// is already Firebase-initialized (see extension/firebase-config.js) and
// holds the anonymous auth session, so routing through it keeps there
// being exactly one place that loads remote SDK code.
const DASHBOARD_URL = 'https://YOUR_PROJECT_ID.web.app/dashboard/index.html';
const SAFE_BROWSING_CONSOLE_URL =
  'https://console.cloud.google.com/apis/library/safebrowsing.googleapis.com';

const SETTINGS_DEFAULTS = {
  safeBrowsingEnabled: false,
  safeBrowsingApiKey: '',
  sensitivity: 2
};

const statusCard = document.getElementById('status-card');
const statusIcon = document.getElementById('status-icon');
const statusLabel = document.getElementById('status-label');
const statusUrlEl = document.getElementById('status-url');
const reasonsList = document.getElementById('reasons-list');
const reportBtn = document.getElementById('report-btn');
const reportMessage = document.getElementById('report-message');
const dashboardLink = document.getElementById('dashboard-link');

const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-panel');

const sbEnabledInput = document.getElementById('sb-enabled');
const sbApiKeyInput = document.getElementById('sb-api-key');
const sbKeyLink = document.getElementById('sb-key-link');
const sensitivitySelect = document.getElementById('sensitivity');
const settingsMessage = document.getElementById('settings-message');

dashboardLink.href = DASHBOARD_URL;
sbKeyLink.href = SAFE_BROWSING_CONSOLE_URL;

let currentTab = null;

// ---- Tabs ---------------------------------------------------------------

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabButtons.forEach((b) => b.classList.toggle('is-active', b === btn));
    tabPanels.forEach((panel) => {
      panel.classList.toggle('is-active', panel.id === `tab-${btn.dataset.tab}`);
    });
  });
});

// ---- Status tab -----------------------------------------------------------

function renderStatus({ url, isDangerous, reasons, unknown }) {
  statusUrlEl.textContent = url || '';
  statusCard.classList.remove('status--safe', 'status--danger', 'status--unknown');
  reasonsList.innerHTML = '';
  reasonsList.hidden = true;

  if (unknown || !url) {
    statusCard.classList.add('status--unknown');
    statusIcon.textContent = '?';
    statusLabel.textContent = 'Unable to check this page';
    return;
  }

  if (isDangerous) {
    statusCard.classList.add('status--danger');
    statusIcon.textContent = '!';
    statusLabel.textContent = 'This site looks dangerous';
    if (reasons && reasons.length) {
      reasonsList.hidden = false;
      reasons.forEach((reason) => {
        const li = document.createElement('li');
        li.textContent = reason;
        reasonsList.appendChild(li);
      });
    }
  } else {
    statusCard.classList.add('status--safe');
    statusIcon.textContent = '✓';
    statusLabel.textContent = 'No issues detected';
  }
}

async function loadStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;

  if (!tab || !tab.url) {
    renderStatus({ unknown: true });
    return;
  }

  chrome.runtime.sendMessage(
    { type: 'GET_TAB_STATUS', tabId: tab.id, url: tab.url },
    (response) => {
      if (chrome.runtime.lastError || !response) {
        renderStatus({ url: tab.url, unknown: true });
        return;
      }
      renderStatus(response);
    }
  );
}

function reportCurrentSite() {
  if (!currentTab || !currentTab.url) return;

  // Stats (incrementScan({ isReport: true })) are recorded by background.js
  // once the report succeeds, not here — popup.js has no Firebase SDK of
  // its own and delegates the whole report flow via REPORT_URL below.
  reportBtn.disabled = true;
  reportMessage.classList.remove('error');
  reportMessage.textContent = 'Submitting report…';
  reportMessage.hidden = false;

  chrome.runtime.sendMessage({ type: 'REPORT_URL', url: currentTab.url }, (response) => {
    reportBtn.disabled = false;

    if (chrome.runtime.lastError || !response || !response.success) {
      reportMessage.textContent =
        (response && response.error) ||
        (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
        'Could not submit report. Please try again later.';
      reportMessage.classList.add('error');
      reportMessage.hidden = false;
      return;
    }

    reportMessage.textContent = response.message || 'Thanks! This site has been reported.';
    reportMessage.classList.remove('error');
    reportMessage.hidden = false;
  });
}

reportBtn.addEventListener('click', reportCurrentSite);

// ---- Settings tab -----------------------------------------------------

let settingsMessageTimer = null;

function showSettingsMessage(text, isError) {
  clearTimeout(settingsMessageTimer);
  settingsMessage.textContent = text;
  settingsMessage.classList.toggle('error', Boolean(isError));
  settingsMessage.hidden = false;
  settingsMessageTimer = setTimeout(() => {
    settingsMessage.hidden = true;
  }, 2000);
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(SETTINGS_DEFAULTS));
  const settings = { ...SETTINGS_DEFAULTS, ...stored };

  sbEnabledInput.checked = Boolean(settings.safeBrowsingEnabled);
  sbApiKeyInput.value = settings.safeBrowsingApiKey || '';
  sensitivitySelect.value = String(settings.sensitivity);
}

async function saveSetting(key, value) {
  try {
    await chrome.storage.local.set({ [key]: value });
    showSettingsMessage('Settings saved.', false);
  } catch (err) {
    showSettingsMessage((err && err.message) || 'Could not save settings.', true);
  }
}

sbEnabledInput.addEventListener('change', () => {
  if (sbEnabledInput.checked && !sbApiKeyInput.value.trim()) {
    showSettingsMessage('Add an API key first to enable Safe Browsing.', true);
    sbEnabledInput.checked = false;
    return;
  }
  saveSetting('safeBrowsingEnabled', sbEnabledInput.checked);
});

sbApiKeyInput.addEventListener('change', () => {
  const key = sbApiKeyInput.value.trim();
  saveSetting('safeBrowsingApiKey', key);
  if (!key && sbEnabledInput.checked) {
    sbEnabledInput.checked = false;
    saveSetting('safeBrowsingEnabled', false);
  }
});

sensitivitySelect.addEventListener('change', () => {
  saveSetting('sensitivity', Number(sensitivitySelect.value));
});

loadStatus();
loadSettings();
