// Runs heuristics on the current page and reports the result to background.js.
// This catches SPA route changes (pushState/replaceState) that don't fire
// webNavigation events, so the background service worker can re-evaluate them.
(function () {
  if (typeof HeuristicsUtil === 'undefined') return;

  let lastUrl = location.href;

  function reportCurrentUrl() {
    chrome.runtime.sendMessage({ type: 'PAGE_CHECK', url: location.href });
  }

  reportCurrentUrl();

  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      reportCurrentUrl();
    }
  });

  observer.observe(document.documentElement, { subtree: true, childList: true });
})();
