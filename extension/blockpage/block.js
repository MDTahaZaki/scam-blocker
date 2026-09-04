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

function render() {
  const { url, reasons } = getQueryParams();

  document.getElementById('blocked-url').textContent = url;

  const list = document.getElementById('reasons-list');
  list.innerHTML = '';

  if (reasons.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'This URL matched our scam detection rules.';
    list.appendChild(li);
    return;
  }

  reasons.forEach((reason) => {
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

document.getElementById('go-back-btn').addEventListener('click', goBack);
render();
