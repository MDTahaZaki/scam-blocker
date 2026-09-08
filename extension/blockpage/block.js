function getQueryParams() {
  const params = new URLSearchParams(window.location.search);
  let reasons = [];
  try {
    reasons = JSON.parse(params.get('reasons') || '[]');
  } catch {
    reasons = [];
  }
  return {
    url: params.get('url') || '',
    reasons: Array.isArray(reasons) ? reasons : []
  };
}

const { url: blockedUrl, reasons: blockedReasons } = getQueryParams();

function render() {
  document.getElementById('blocked-url').textContent = blockedUrl;

  const list = document.getElementById('reasons-list');
  list.innerHTML = '';

  if (blockedReasons.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'This URL matched our scam detection rules.';
    list.appendChild(li);
    return;
  }

  blockedReasons.forEach((reason) => {
    const li = document.createElement('li');
    li.textContent = reason;
    list.appendChild(li);
  });
}

function goBack() {
  if (window.history.length > 1) {
    window.history.back();
    return;
  }
  // No history to return to (e.g. link opened in a new tab) — close it.
  if (chrome.tabs && chrome.tabs.getCurrent) {
    chrome.tabs.getCurrent((tab) => {
      if (tab && tab.id !== undefined) {
        chrome.tabs.remove(tab.id);
      }
    });
  }
}

// Two-step confirmation instead of a native confirm() dialog: the first
// click reveals an explicit warning + a second button, so leaving the
// block page always requires a deliberate second action.
function showProceedWarning() {
  document.getElementById('proceed-warning').hidden = false;
  document.getElementById('proceed-btn').hidden = true;
}

function proceedAnyway() {
  if (!blockedUrl) return;

  const confirmBtn = document.getElementById('proceed-confirm-btn');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Loading…';

  chrome.runtime.sendMessage({ type: 'PROCEED_ANYWAY', url: blockedUrl }, (response) => {
    if (chrome.runtime.lastError || !response || !response.success) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Yes, take me there';
      return;
    }
    // The domain is now temporarily whitelisted (24h) — navigate immediately.
    window.location.href = blockedUrl;
  });
}

document.getElementById('go-back-btn').addEventListener('click', goBack);
document.getElementById('proceed-btn').addEventListener('click', showProceedWarning);
document.getElementById('proceed-confirm-btn').addEventListener('click', proceedAnyway);
render();
