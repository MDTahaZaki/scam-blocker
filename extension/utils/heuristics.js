// Heuristic scam-URL checks. Loaded as a classic script by background.js
// (MV3 service worker via importScripts) and by content.js.
// Exposes `HeuristicsUtil.checkUrl(url)` -> { isScam: boolean, reasons: string[] }

(function (global) {
  const SUSPICIOUS_TLDS = ['.tk', '.ml', '.ga', '.cf', '.gq', '.xyz', '.top', '.club', '.work', '.click', '.link'];

  const SCAM_KEYWORDS = [
    'login', 'verify', 'verification', 'account', 'update', 'bank',
    'secure', 'signin', 'sign-in', 'confirm', 'password', 'suspend',
    'suspended', 'wallet', 'invoice', 'billing', 'unlock', 'reward',
    'gift', 'prize', 'urgent'
  ];

  const IPV4_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const MAX_URL_LENGTH = 100;
  const MAX_SUBDOMAINS = 3;

  function isIpAddress(hostname) {
    const match = hostname.match(IPV4_REGEX);
    if (!match) return false;
    return match.slice(1, 5).every((part) => Number(part) <= 255);
  }

  function countSubdomains(hostname) {
    // e.g. a.b.c.example.com -> 3 subdomains before "example.com"
    const parts = hostname.split('.').filter(Boolean);
    return Math.max(0, parts.length - 2);
  }

  function hasSuspiciousTld(hostname) {
    return SUSPICIOUS_TLDS.some((tld) => hostname.endsWith(tld));
  }

  function checkUrl(url) {
    const reasons = [];
    let parsed;

    try {
      parsed = new URL(url);
    } catch (err) {
      return { isScam: false, reasons: [] };
    }

    const hostname = parsed.hostname.toLowerCase();
    const fullUrl = url.toLowerCase();

    if (url.length > MAX_URL_LENGTH) {
      reasons.push(`URL is unusually long (${url.length} characters)`);
    }

    if (isIpAddress(hostname)) {
      reasons.push('URL uses a raw IP address instead of a domain name');
    }

    if (hasSuspiciousTld(hostname)) {
      const tld = SUSPICIOUS_TLDS.find((t) => hostname.endsWith(t));
      reasons.push(`Domain uses a commonly abused TLD (${tld})`);
    }

    if (countSubdomains(hostname) > MAX_SUBDOMAINS) {
      reasons.push('URL has an excessive number of subdomains');
    }

    if (url.includes('@')) {
      reasons.push('URL contains an "@" symbol, which can hide the real destination');
    }

    if (hostname.includes('-')) {
      reasons.push('Domain contains hyphens, often used to imitate legitimate brands');
    }

    const matchedKeywords = SCAM_KEYWORDS.filter((kw) => fullUrl.includes(kw));
    if (matchedKeywords.length > 0) {
      reasons.push(`URL contains suspicious keyword(s): ${matchedKeywords.join(', ')}`);
    }

    return {
      isScam: reasons.length > 0,
      reasons
    };
  }

  const HeuristicsUtil = { checkUrl };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = HeuristicsUtil;
  } else {
    global.HeuristicsUtil = HeuristicsUtil;
  }
})(typeof self !== 'undefined' ? self : this);
