# Manual testing checklist

Automated tests (`npm test`) only cover the heuristics scoring engine in
isolation. Everything below — the extension UI, the Firebase backend, the
dashboard, and the mobile PWA — needs to be walked through by hand before
calling a change "done." This is the checklist to run after any change that
touches detection logic, the backend, or either UI.

## Extension

- [ ] Load the extension in Chrome (`chrome://extensions` → Developer mode →
      **Load unpacked** → select `extension/`) with no console errors.
- [ ] Visit `https://example.com` → popup shows **No issues detected**, no
      redirect to the block page.
- [ ] Visit `http://192.168.1.1/login` (or any raw-IP URL with a `login`
      path) → the tab is redirected to the block page, listing the raw-IP
      and keyword reasons.
- [ ] Visit `https://vice-support.servicediy.in` → blocked, reasons include
      the support-subdomain-on-unusual-TLD flag (see
      `extension/utils/heuristics.js`'s `findSupportSubdomainScam`).
- [ ] On the block page, click **Back to safety** → tab navigates away from
      the blocked URL.
- [ ] Revisit a blocked URL, click **Proceed anyway**, confirm the second
      prompt → the tab loads the real page, and revisiting it within 24h
      does not re-block it (temporary whitelist).
- [ ] Open the popup on a `chrome://extensions` or `chrome://settings` tab →
      **Report this site as scam** button is disabled.
- [ ] Open the popup on any `http(s)://` page → click **Report this site as
      scam** → success message shown; in the Firebase console, a document
      appears under `reported_urls` with that URL, your anonymous `uid` in
      `reportedBy`, and `count: 1`.
- [ ] Trigger 3 reports of the same URL from 3 distinct anonymous sessions
      (e.g. 3 separate Chrome profiles, or clear `chrome.storage`/re-install
      between reports) → the URL appears in the `blocklist` collection.
- [ ] Revisit that now-blocklisted URL → the extension blocks it via the
      synced blocklist (not just heuristics) within the next hourly sync, or
      immediately after manually triggering the `blocklistSync` alarm.
- [ ] In the popup's **Settings** tab, toggle **Detection sensitivity**
      between Low/Medium/High and confirm a borderline URL (one weak signal
      only, e.g. a single suspicious keyword) is blocked at High but not at
      Low.
- [ ] With a valid Safe Browsing API key entered and enabled, visit a known
      test phishing URL (Google publishes test URLs for this) → flagged via
      Safe Browsing even when heuristics alone wouldn't catch it.

## Dashboard

- [ ] Open the deployed dashboard URL (or serve `dashboard/` over a local
      static server — not `file://`) → **Total scans**, **Total blocked**,
      **Total reported** counters render from `stats/global`.
- [ ] Use the extension for a few navigations, then reload the dashboard →
      **Total scans** increases.
- [ ] Submit a report from the extension or PWA, then reload the dashboard →
      **Total reported** increases.
- [ ] Click **Add test blocklist entry** → `https://example-phishing.com` is
      added to the blocklist table without a page reload.

## Mobile PWA

- [ ] Open the hosted PWA URL on Android Chrome, paste a known-safe URL,
      tap **Check Link** → **Safe** badge.
- [ ] Paste `https://vice-support.servicediy.in` → **Dangerous** badge with
      reasons listed.
- [ ] Install the PWA (**Add to Home screen** / install prompt).
- [ ] From another app (browser, WhatsApp, SMS), use the share sheet and
      pick the installed PWA → it opens directly to the result for the
      shared URL (Web Share Target).
- [ ] Tap **Report as Scam** on a flagged result → success message; confirm
      the report lands in Firestore the same way as the extension's report.
- [ ] With `firebase-config.js` left at its default empty `apiKey` → the PWA
      still checks URLs via heuristics, shows the "local-only mode" warning
      banner, and both blocklist sync and reporting are disabled without
      throwing.

## Backend hardening (after any change to `backend/functions/index.js`)

- [ ] Call `reportUrl` with a non-string, an overly long (>2000 char), or a
      non-http(s) `url` → rejected with `invalid-argument`, not a crash.
- [ ] Call `reportUrl` as an unauthenticated caller → rejected with
      `unauthenticated`.
- [ ] Call `reportUrl` more than 10 times within an hour from the same
      (anonymous) uid → the 11th call is rejected with `resource-exhausted`.
- [ ] From a plain client (not via a callable, e.g. the Firestore console or
      REST) attempt to read `reported_urls` or `report_log`, or write to
      `blocklist` or `stats` directly → denied by `firestore.rules`.

## Automated tests

- [ ] `npm test` passes locally.
- [ ] The `Test` GitHub Actions workflow (`.github/workflows/test.yml`)
      passes on the pushed branch/PR.
