// Tests for extension/utils/heuristics.js's checkUrl(url, sensitivity).
//
// checkUrl scores a URL against a set of weighted signals and only reports
// isScam:true once the score crosses a threshold that depends on
// `sensitivity` (1 = strict/threshold 6, 2 = balanced/default/threshold 4,
// 3 = aggressive/threshold 2). Several rules below are individually
// "weak" (weight 1-2) and only cross the default (sensitivity 2) threshold
// when combined with a second signal, exactly as they would on a real scam
// URL that stacks several red flags — where a test needs to isolate a
// single weak signal in ~just~ that rule, it explicitly passes sensitivity
// 3 (aggressive) instead of relying on the default.
const { checkUrl } = require('../extension/utils/heuristics.js');

describe('checkUrl: legitimate URLs', () => {
  test('google.com is not flagged', () => {
    const result = checkUrl('https://www.google.com');
    expect(result.isScam).toBe(false);
  });

  test('github.com is not flagged', () => {
    const result = checkUrl('https://github.com');
    expect(result.isScam).toBe(false);
  });

  test('wikipedia.org (with subdomain) is not flagged', () => {
    const result = checkUrl('https://en.wikipedia.org/wiki/Phishing');
    expect(result.isScam).toBe(false);
  });

  test('microsoft.com with a path is not flagged', () => {
    const result = checkUrl('https://www.microsoft.com/en-us/');
    expect(result.isScam).toBe(false);
  });

  test('a brand subdomain on the official domain is not flagged (paypal)', () => {
    const result = checkUrl('https://www.paypal.com/signin');
    // Same domain as the brand's official domain -> exempt from brand-
    // impersonation flagging, even though "signin" is a scam keyword; a
    // single weak keyword hit alone does not cross the default threshold.
    expect(result.isScam).toBe(false);
  });

  test('a support subdomain on a trusted TLD is not flagged (apple)', () => {
    const result = checkUrl('https://support.apple.com/en-us');
    expect(result.isScam).toBe(false);
  });
});

describe('checkUrl: IP-address URLs', () => {
  test('raw IP + login path is flagged at default sensitivity', () => {
    const result = checkUrl('http://192.168.1.1/login');
    expect(result.isScam).toBe(true);
    expect(result.reasons.some((r) => r.includes('IP address'))).toBe(true);
  });

  test('raw IP + verify/account path is flagged at default sensitivity', () => {
    const result = checkUrl('http://45.33.32.156/verify-account');
    expect(result.isScam).toBe(true);
  });

  test('a bare raw IP alone is flagged at aggressive sensitivity', () => {
    const result = checkUrl('http://203.0.113.5/', 3);
    expect(result.isScam).toBe(true);
    expect(result.reasons.some((r) => r.includes('IP address'))).toBe(true);
  });
});

describe('checkUrl: suspicious TLDs', () => {
  test('.tk domain combined with a scam keyword is flagged by default', () => {
    const result = checkUrl('http://freegift.tk/');
    expect(result.isScam).toBe(true);
    expect(result.reasons.some((r) => r.includes('abused TLD'))).toBe(true);
  });

  test('.ml domain alone is flagged at aggressive sensitivity', () => {
    const result = checkUrl('http://totallylegitsite.ml/', 3);
    expect(result.isScam).toBe(true);
  });

  test('.xyz domain alone is flagged at aggressive sensitivity', () => {
    const result = checkUrl('http://cheapdeals.xyz/', 3);
    expect(result.isScam).toBe(true);
  });
});

describe('checkUrl: "@" in the URL authority', () => {
  test('a fake paypal userinfo hiding the real host is flagged', () => {
    const result = checkUrl('http://paypal.com@evilsite.tk/login');
    expect(result.isScam).toBe(true);
    expect(result.reasons.some((r) => r.includes('@'))).toBe(true);
  });
});

describe('checkUrl: excessive subdomains', () => {
  test('four subdomains plus a suspicious TLD is flagged at aggressive sensitivity', () => {
    const result = checkUrl('http://a.b.c.d.freehost.xyz/', 3);
    expect(result.isScam).toBe(true);
    expect(result.reasons.some((r) => r.includes('subdomains'))).toBe(true);
  });
});

describe('checkUrl: phishing keywords in host/path', () => {
  test('bank/secure/login keywords plus a suspicious TLD is flagged by default', () => {
    const result = checkUrl('http://mybank-secure-portal.xyz/login');
    expect(result.isScam).toBe(true);
    expect(result.reasons.some((r) => r.includes('suspicious keyword'))).toBe(true);
  });

  test('account/verify path keywords alone are flagged at aggressive sensitivity', () => {
    const result = checkUrl('http://example.com/account/verify', 3);
    expect(result.isScam).toBe(true);
  });
});

describe('checkUrl: very long URLs', () => {
  test('an unusually long URL with a scam keyword is flagged at aggressive sensitivity', () => {
    const longUrl = `https://example.com/verify-${'x'.repeat(105)}`;
    const result = checkUrl(longUrl, 3);
    expect(result.isScam).toBe(true);
    expect(result.reasons.some((r) => r.includes('unusually long'))).toBe(true);
  });
});

describe('checkUrl: the real-world scam case', () => {
  test('vice-support.servicediy.in (fake appliance support site) is flagged by default', () => {
    const result = checkUrl('https://vice-support.servicediy.in');
    expect(result.isScam).toBe(true);
    expect(
      result.reasons.some((r) => r.includes('support/service-style term'))
    ).toBe(true);
  });
});

describe('checkUrl: brand impersonation', () => {
  test('amazon referenced on an unrelated .tk domain is flagged by default', () => {
    const result = checkUrl('https://www.amazon-security-alert.tk/');
    expect(result.isScam).toBe(true);
    expect(
      result.reasons.some((r) => r.includes('Brand name used on non-official domain'))
    ).toBe(true);
  });

  test('paypal referenced on an unrelated .info domain is flagged by default', () => {
    const result = checkUrl('https://update.paypal-verify.info/');
    expect(result.isScam).toBe(true);
    expect(
      result.reasons.some((r) => r.includes('Brand name used on non-official domain'))
    ).toBe(true);
  });
});

describe('checkUrl: IDN homograph risk', () => {
  test('a punycode lookalike domain with a login path is flagged by default', () => {
    const result = checkUrl('https://xn--pypal-4ve.com/login/verify');
    expect(result.isScam).toBe(true);
    expect(result.reasons.some((r) => r.includes('homograph'))).toBe(true);
  });
});

describe('checkUrl: excessive hyphens / digits', () => {
  test('excessive hyphens plus a suspicious TLD and keywords is flagged by default', () => {
    const result = checkUrl('http://secure-login-verify-account.info/');
    expect(result.isScam).toBe(true);
    expect(result.reasons.some((r) => r.includes('hyphens'))).toBe(true);
  });

  test('excessive digits plus a suspicious TLD is flagged at aggressive sensitivity', () => {
    const result = checkUrl('http://192837465.freehost.tk/', 3);
    expect(result.isScam).toBe(true);
    expect(result.reasons.some((r) => r.includes('digits'))).toBe(true);
  });
});

describe('checkUrl: invalid input never throws', () => {
  test('empty string returns a safe empty result', () => {
    expect(checkUrl('')).toEqual({ isScam: false, reasons: [], score: 0, sensitivity: 2 });
  });

  test('null returns a safe empty result', () => {
    expect(checkUrl(null)).toEqual({ isScam: false, reasons: [], score: 0, sensitivity: 2 });
  });

  test('undefined returns a safe empty result', () => {
    expect(checkUrl(undefined)).toEqual({ isScam: false, reasons: [], score: 0, sensitivity: 2 });
  });

  test('a malformed, non-URL string returns a safe empty result', () => {
    expect(checkUrl('not a url at all')).toEqual({
      isScam: false,
      reasons: [],
      score: 0,
      sensitivity: 2
    });
  });
});
