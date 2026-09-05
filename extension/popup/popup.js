// ---- Configuration ---------------------------------------------------
// Replace with your hosted dashboard URL.
//
// Reporting is delegated to background.js via chrome.runtime.sendMessage
// rather than loading the Firebase SDK a second time here: background.js
// is already Firebase-initialized (see extension/firebase-config.js) and
// holds the anonymous auth session, so routing through it keeps there
// being exactly one place that loads remote SDK code.
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

function reportCurrentSite() {
  if (!currentTab || !currentTab.url) return;

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
loadStatus();
