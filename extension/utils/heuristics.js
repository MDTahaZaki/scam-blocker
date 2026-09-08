// Heuristic scam-URL checks. Loaded as a classic script by background.js
// (MV3 service worker via importScripts) and by content.js.
// Exposes `HeuristicsUtil.checkUrl(url, sensitivity)` ->
//   { isScam: boolean, reasons: string[], score: number, sensitivity: number }
//
// Each rule contributes a weight to a running score instead of flagging on
// its own; `sensitivity` (1 = strict, 2 = balanced, 3 = aggressive) picks
// the score threshold required to call the URL a scam. This lets a single
// low-confidence signal (e.g. a long URL) go through at sensitivity 1 while
// still tripping the alarm at sensitivity 3, without needing two separate
// code paths.

(function (global) {
  const SUSPICIOUS_TLDS = [
    '.tk', '.ml', '.ga', '.cf', '.gq', '.xyz', '.top', '.club', '.work',
    '.click', '.link', '.support', '.info', '.online', '.site', '.live',
    '.icu', '.rest', '.buzz', '.fit', '.mom', '.cam', '.cyou', '.monster',
    '.quest', '.bond'
  ];

  // Matched anywhere in the URL (host, path, or query) — kept broad on
  // purpose so brand/action combinations like "paypal-login" still hit.
  const SCAM_KEYWORDS = [
    'login', 'verify', 'verification', 'account', 'update', 'bank',
    'secure', 'signin', 'sign-in', 'confirm', 'password', 'suspend',
    'suspended', 'wallet', 'invoice', 'billing', 'unlock', 'reward',
    'gift', 'prize', 'urgent', 'paypal', 'webscr', 'cmd'
  ];

  const BRAND_NAMES = [
    'whirlpool', 'paypal', 'amazon', 'google', 'microsoft', 'apple',
    'netflix', 'facebook', 'instagram', 'chase', 'wellsfargo',
    'bankofamerica', 'irs', 'dhl', 'fedex', 'ups', 'usps', 'coinbase',
    'binance', 'ebay', 'walmart'
  ];
  const OFFICIAL_TLDS = ['com', 'org', 'net', 'co'];

  const IPV4_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const MAX_URL_LENGTH = 120;
  const MAX_SUBDOMAINS = 3;
  const MAX_HYPHENS = 2;
  const MAX_DIGITS = 4;

  // score thresholds required to flag isScam=true, keyed by sensitivity.
  // Lower threshold = fewer/weaker signals needed = more aggressive.
  const SENSITIVITY_THRESHOLDS = { 1: 6, 2: 4, 3: 2 };
  const DEFAULT_SENSITIVITY = 2;

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

  function countHyphens(hostname) {
    return (hostname.match(/-/g) || []).length;
  }

  function countDigits(hostname) {
    return (hostname.match(/\d/g) || []).length;
  }

  // Returns the impersonated brand name, or null if none applies.
  function findBrandImpersonation(hostname) {
    const brand = BRAND_NAMES.find((b) => hostname.includes(b));
    if (!brand) return null;

    const officialDomain = `${brand}.com`;
    if (hostname === officialDomain || hostname.endsWith(`.${officialDomain}`)) {
      return null; // it *is* (a subdomain of) the real thing
    }

    const parts = hostname.split('.').filter(Boolean);
    const tld = parts[parts.length - 1] || '';
    const isCountryTld = /^[a-z]{2}$/i.test(tld); // e.g. "uk", "de", "ca"
    if (OFFICIAL_TLDS.includes(tld) || isCountryTld) return null;

    return brand;
  }

  // Chrome's URL parser always punycode-encodes non-ASCII hostnames
  // (segments become "xn--..."), so a decoded-looking check isn't needed —
  // presence of the ACE prefix, or of stray non [a-z0-9.-] characters, is
  // enough to flag a possible IDN homograph domain.
  function hasHomographRisk(hostname) {
    if (hostname.includes('xn--')) return true;
    return !/^[a-z0-9.-]+$/i.test(hostname);
  }

  function checkUrl(url, sensitivity) {
    const level = [1, 2, 3].includes(sensitivity) ? sensitivity : DEFAULT_SENSITIVITY;
    const threshold = SENSITIVITY_THRESHOLDS[level];

    const reasons = [];
    let score = 0;
    let parsed;

    try {
      parsed = new URL(url);
    } catch (err) {
      return { isScam: false, reasons: [], score: 0, sensitivity: level };
    }

    const hostname = parsed.hostname.toLowerCase();
    const fullUrl = url.toLowerCase();
    const pathAndQuery = `${parsed.pathname}${parsed.search}`.toLowerCase();

    function flag(weight, reason) {
      score += weight;
      reasons.push(reason);
    }

    if (url.length > MAX_URL_LENGTH) {
      flag(1, `URL is unusually long (${url.length} characters)`);
    }

    if (isIpAddress(hostname)) {
      flag(3, 'URL uses a raw IP address instead of a domain name');
    }

    if (hasSuspiciousTld(hostname)) {
      const tld = SUSPICIOUS_TLDS.find((t) => hostname.endsWith(t));
      flag(2, `Domain uses a commonly abused TLD (${tld})`);
    }

    if (countSubdomains(hostname) > MAX_SUBDOMAINS) {
      flag(1, 'URL has an excessive number of subdomains');
    }

    // "@" anywhere in the authority (before the path/query/fragment) lets
    // everything before it masquerade as a username, hiding the real host
    // (e.g. https://paypal.com@evil.tk/).
    if (/:\/\/[^/?#]*@/.test(url)) {
      flag(3, 'URL contains an "@" symbol in the authority, which can hide the real destination');
    }

    if (countHyphens(hostname) > MAX_HYPHENS) {
      flag(1, 'Domain contains an excessive number of hyphens, often used to imitate legitimate brands');
    }

    if (countDigits(hostname) > MAX_DIGITS) {
      flag(1, 'Domain contains an excessive number of digits');
    }

    const matchedKeywords = SCAM_KEYWORDS.filter((kw) => pathAndQuery.includes(kw) || hostname.includes(kw));
    if (matchedKeywords.length > 0) {
      flag(2, `URL contains suspicious keyword(s): ${[...new Set(matchedKeywords)].join(', ')}`);
    }

    const impersonatedBrand = findBrandImpersonation(hostname);
    if (impersonatedBrand) {
      flag(3, `Domain references "${impersonatedBrand}" but is not on ${impersonatedBrand}'s official domain`);
    }

    if (hasHomographRisk(hostname)) {
      flag(3, 'Domain contains non-standard characters, possibly an IDN homograph (lookalike) attack');
    }

    return {
      isScam: score >= threshold,
      reasons,
      score,
      sensitivity: level
    };
  }

  const HeuristicsUtil = { checkUrl };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = HeuristicsUtil;
  } else {
    global.HeuristicsUtil = HeuristicsUtil;
  }
})(typeof self !== 'undefined' ? self : this);
