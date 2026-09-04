// ---- Configuration ---------------------------------------------------
// Replace with your deployed Cloud Functions base URL and hosted dashboard URL.
const FUNCTIONS_BASE_URL = 'https://REGION-YOUR_PROJECT_ID.cloudfunctions.net';
const REPORT_URL_ENDPOINT = `${FUNCTIONS_BASE_URL}/reportUrl`;
const DASHBOARD_URL = 'https://YOUR_PROJECT_ID.web.app/dashboard/index.html';

const statusCard = document.getElementById('status-card');
const statusIcon = document.getElementById('status-icon');
const statusLabel = document.getElementById('status-label');
const statusUrlEl = document.getElementById('status-url');
const reasonsList = document.getElementById('reasons-list');
const reportBtn = document.getElementById('report-btn');
const reportMessage = document.getElementById('report-message');
const dashboardLink = document.getElementById('dashboard-link');

dashboardLink.href = DASHBOARD_URL;

let currentTab = null;

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

// A random id persisted locally so reportUrl can count distinct reporters
// without requiring the Firebase Auth client SDK (no build step here).
async function getAnonUid() {
  const { anonUid } = await chrome.storage.local.get('anonUid');
  if (anonUid) return anonUid;

  const newUid = 'anon-' + crypto.randomUUID();
  await chrome.storage.local.set({ anonUid: newUid });
  return newUid;
}

async function reportCurrentSite() {
  if (!currentTab || !currentTab.url) return;

  reportBtn.disabled = true;
  reportMessage.hidden = true;
  reportMessage.classList.remove('error');

  try {
    const uid = await getAnonUid();
    const res = await fetch(REPORT_URL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: currentTab.url, uid })
    });

    if (!res.ok) throw new Error(`Server responded ${res.status}`);

    reportMessage.textContent = 'Thanks! This site has been reported.';
    reportMessage.hidden = false;
  } catch (err) {
    reportMessage.textContent = 'Could not submit report. Please try again later.';
    reportMessage.classList.add('error');
    reportMessage.hidden = false;
  } finally {
    reportBtn.disabled = false;
  }
}

reportBtn.addEventListener('click', reportCurrentSite);
loadStatus();
