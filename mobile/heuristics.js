// Heuristic scam-URL checks. Identical logic to extension/utils/heuristics.js
// (duplicated here so the PWA has no build step / import wiring back to
// extension/), loaded as a classic <script> by mobile/index.html before
// mobile/app.js.
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

  // Official registered domain for each brand, used by findBrandImpersonation
  // below. A brand missing from this map falls back to "<brand>.com".
  const OFFICIAL_DOMAINS = {
    whirlpool: 'whirlpool.com', paypal: 'paypal.com', amazon: 'amazon.com',
    google: 'google.com', microsoft: 'microsoft.com', apple: 'apple.com',
    netflix: 'netflix.com', facebook: 'facebook.com', instagram: 'instagram.com',
    chase: 'chase.com', wellsfargo: 'wellsfargo.com', bankofamerica: 'bankofamerica.com',
    irs: 'irs.gov', dhl: 'dhl.com', fedex: 'fedex.com', ups: 'ups.com',
    usps: 'usps.com', coinbase: 'coinbase.com', binance: 'binance.com',
    ebay: 'ebay.com', walmart: 'walmart.com',
    sbi: 'onlinesbi.com', hdfc: 'hdfcbank.com', icici: 'icicibank.com',
    flipkart: 'flipkart.com'
  };
  const BRAND_NAMES = Object.keys(OFFICIAL_DOMAINS);

  // Subdomain-only terms typical of fake "tech support" / "customer care"
  // scam pages (e.g. a fraudulent "vice-support.servicediy.in" posing as an
  // appliance brand's support line). Deliberately generic rather than tied
  // to a specific brand list, since this scam pattern reuses the same
  // playbook against many different real-world brands.
  const SUPPORT_SCAM_SUBDOMAIN_TERMS = [
    'support', 'service', 'helpdesk', 'helpline', 'care', 'assist',
    'technician', 'repair', 'customercare'
  ];
  // TLDs treated as "standard" for the support-subdomain check below; a
  // support/service subdomain sitting on anything outside this short list
  // is unusual enough to flag. Deliberately narrow — this rule trades some
  // false positives on legitimate regional businesses (e.g.
  // support.company.in) for catching this specific scam pattern; see
  // README limitations.
  const TRUSTED_SUPPORT_TLDS = ['com', 'org', 'net', 'co', 'gov', 'edu'];

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

  // Returns { brand, officialDomain }, or null if no impersonation applies.
  // Note: this only exempts hostnames that are the official domain (or a
  // subdomain of it) — any other TLD/domain combination containing the
  // brand name is flagged. Earlier versions of this rule also exempted any
  // two-letter country-code TLD (e.g. "brand-support.xx"), which is exactly
  // the trick scam domains use to look legitimate, so that exemption was
  // removed.
  function findBrandImpersonation(hostname) {
    // Match against dot/hyphen-separated tokens rather than a raw substring
    // search — some brand codes are short (e.g. "ups", "sbi"), and a raw
    // `hostname.includes(brand)` would false-positive on unrelated domains
    // that merely contain those letters in sequence (e.g. "groups.google.com"
    // contains "ups"). Short brand codes (<5 chars) require an exact token
    // match; longer ones may appear as a substring within a token (so
    // "whirlpool-support.tld" -> token "whirlpool-support" split further by
    // hyphen already isolates "whirlpool", but "whirlpoolsupport" as one
    // fused token still matches via substring).
    const tokens = hostname.split(/[.-]/).filter(Boolean);
    const brand = BRAND_NAMES.find((b) =>
      tokens.some((t) => (b.length < 5 ? t === b : t.includes(b)))
    );
    if (!brand) return null;

    const officialDomain = OFFICIAL_DOMAINS[brand] || `${brand}.com`;
    if (hostname === officialDomain || hostname.endsWith(`.${officialDomain}`)) {
      return null; // it *is* (a subdomain of) the real thing
    }

    return { brand, officialDomain };
  }

  // Detects a support/service-style subdomain (e.g. "vice-support",
  // "helpdesk") sitting on a domain whose TLD isn't one of the common
  // trusted ones — the pattern used by fake tech-support scam sites that
  // impersonate a brand's customer care line without using the brand's
  // name directly in a way SCAM_KEYWORDS or findBrandImpersonation would
  // catch. Returns the matched subdomain term, or null.
  function findSupportSubdomainScam(hostname) {
    const labels = hostname.split('.').filter(Boolean);
    if (labels.length < 3) return null; // no room for a distinct subdomain

    const tld = labels[labels.length - 1];
    if (TRUSTED_SUPPORT_TLDS.includes(tld)) return null;

    const subdomainLabels = labels.slice(0, -2);
    for (const label of subdomainLabels) {
      const term = SUPPORT_SCAM_SUBDOMAIN_TERMS.find((t) => label.includes(t));
      if (term) return term;
    }
    return null;
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

    const impersonation = findBrandImpersonation(hostname);
    if (impersonation) {
      flag(
        3,
        `Brand name used on non-official domain: references "${impersonation.brand}" but is not ${impersonation.officialDomain} or a subdomain of it`
      );
    }

    const supportScamTerm = findSupportSubdomainScam(hostname);
    if (supportScamTerm) {
      flag(
        4,
        `Subdomain uses a support/service-style term ("${supportScamTerm}") on an unusual top-level domain — a common fake tech-support scam pattern`
      );
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
