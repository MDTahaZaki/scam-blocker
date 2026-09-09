# Scam Link Detector

A Chrome (Manifest V3) extension that blocks scam/phishing links using a
Firebase-synced blocklist plus local heuristic rules, backed by a minimal
Firebase Cloud Functions + Firestore backend, with a small read-only
dashboard.

No build step anywhere — the extension and dashboard are plain HTML/CSS/JS
and can be loaded/served as-is.

## Project structure

```
scam-blocker/
├── extension/     Chrome MV3 extension (load unpacked)
├── backend/       Firebase Cloud Functions + Firestore rules
├── dashboard/     Static dashboard (Chart.js), deployable to Firebase Hosting
└── mobile/        Installable PWA (paste-and-check + Android share target)
```

## 1. Firebase Setup

1. Go to the [Firebase console](https://console.firebase.google.com/) and
   create a new project.
2. Enable **Firestore Database** (production mode is fine — rules are
   provided in `backend/firestore.rules`).
3. Enable **Authentication** → Sign-in method → **Anonymous**. The
   extension signs every user in anonymously so `reportUrl` can attribute
   reports to a stable `uid` without ever asking for credentials.
4. Enable **Cloud Functions** (this requires the project to be on the
   Blaze pay-as-you-go plan; the free tier's included quota covers this
   extension's traffic for typical usage).
5. Install the Firebase CLI if you don't have it, and point it at your
   project:
   ```bash
   npm install -g firebase-tools
   firebase login
   cd backend
   firebase use --add
   # select your project, give it an alias (e.g. "default")
   ```
6. Install function dependencies and deploy the rules + functions:
   ```bash
   cd backend/functions
   npm install
   cd ..
   firebase deploy --only firestore:rules,functions
   ```
7. In the Firebase console, go to **Project settings → General → Your apps**,
   add a **Web app**, and copy the resulting config object.
8. Paste those values into `extension/firebase-config.js`:
   ```js
   const firebaseConfig = {
     apiKey: '...',
     authDomain: '...',
     projectId: '...',
     storageBucket: '...',
     messagingSenderId: '...',
     appId: '...'
   };
   ```
   Leaving `apiKey` empty (the shipped default) runs the extension in
   **local-only mode**: heuristics and any previously-cached blocklist still
   work, but sync and reporting are disabled until this is filled in.
9. Load the extension (see below) and test: open the popup on any page and
   click **Report this site as scam**, then check the Firestore console —
   a `reported_urls` document should appear, and after 3 distinct anonymous
   users report the same URL it should also appear in `blocklist`.

The backend exposes four **callable** functions (not raw HTTP endpoints —
the Firebase Functions SDK handles auth, CORS, and serialization):
- `reportUrl({ url })` — requires an authenticated (anonymous is fine)
  caller; records the report and auto-blocklists a URL once 3 distinct
  uids have reported it.
- `getBlocklist()` — public, no auth required; returns the blocklist as a
  plain array of URL strings, cached in-memory server-side for 5 minutes.
- `incrementScan({ isScam, isReport })` — stats hook, best-effort, writes
  to the single `stats/global` document: increments `totalScans` (and
  `totalBlocked` when `isScam` is true) on every URL check, or
  `totalReported` when called with `{ isReport: true }` after a
  successful `reportUrl`.
- `addTestBlocklistEntry()` — requires an authenticated (anonymous is
  fine) caller; adds a fixed demo URL (`https://example-phishing.com`) to
  `blocklist`, used by the dashboard's "Add test blocklist entry" button
  so there's something to look at without waiting for 3 real reports.

### Manifest V3 and remote code

Chrome Web Store policy prohibits published extensions from executing
remotely-hosted code. `extension/background.js` loads the Firebase
"compat" SDK from Google's CDN via `importScripts()`, which needs the
`content_security_policy` override already present in
`extension/manifest.json` (`script-src 'self' https://www.gstatic.com`).
This works fine for local development and side-loaded/enterprise-policy
installs, but **a Chrome Web Store submission would need the SDK files
vendored locally** instead (e.g. under `extension/vendor/firebase/`), with
the `importScripts()` paths updated to match and the CSP override removed.
Either way, the extension degrades gracefully if the SDK can't load: it
falls back to local heuristics plus whatever blocklist is already cached.

## 2. Load the extension in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Pin the extension and open a page — the popup will show whether the
   current page looks safe, and a "Report this site as scam" button submits
   the current URL via the `reportUrl` callable.
5. The blocklist is fetched via the `getBlocklist` callable on
   install/startup and every hour afterward (`chrome.alarms`), and cached
   in `chrome.storage.local`.

## 3. Set up Google Safe Browsing (optional)

The extension can supplement local heuristics with Google's **Safe
Browsing Lookup API v4** — a free-tier cloud check against Google's
constantly-updated list of malware/phishing sites.

1. In the [Google Cloud Console](https://console.cloud.google.com/), create
   (or pick) a project and enable the **Safe Browsing API**
   (APIs & Services → Library → search "Safe Browsing API" → Enable).
2. Go to **APIs & Services → Credentials → Create credentials → API key**.
   Restrict the key to the Safe Browsing API if you want (recommended).
3. Open the extension popup → **Settings** tab, paste the key into
   **Safe Browsing API key**, and check **Enable Google Safe Browsing**.
   Both are saved immediately to `chrome.storage.local`
   (`safeBrowsingApiKey`, `safeBrowsingEnabled`) — no reload needed.
4. The free tier's quota is generous for personal use. To keep usage low,
   the extension only calls Safe Browsing for a URL that local heuristics
   and the blocklist did **not** already flag, and caches each verdict
   (safe or unsafe) in `chrome.storage.local` for 24 hours so the same URL
   isn't looked up twice in a day.
5. If the key is missing, invalid, or the API call fails for any reason,
   the extension silently falls back to heuristics + blocklist only —
   Safe Browsing is always an optional, best-effort layer.

### Adjusting detection sensitivity

Also in the popup's **Settings** tab, **Detection sensitivity** controls
how many/how strong the heuristic signals in
`extension/utils/heuristics.js` need to be before a URL is blocked:

- **Low** — only blocks when several signals combine (fewer false
  positives, may miss borderline sites).
- **Medium** (default) — balanced; a couple of strong signals (e.g. a raw
  IP address, or a brand name on the wrong domain) is enough on its own.
- **High** — a single moderate signal (e.g. one suspicious keyword) can be
  enough to block; catches more but is more prone to flagging legitimate
  sites.

Internally this is a numeric score: each heuristic rule contributes a
weight, and the sensitivity level just picks the score threshold required
to call a URL a scam (see `SENSITIVITY_THRESHOLDS` in
`extension/utils/heuristics.js`). The setting is stored as `sensitivity`
(`1`/`2`/`3`) in `chrome.storage.local`.

## 4. Set up and deploy the dashboard (optional)

1. In `dashboard/dashboard.js`, replace the placeholder `firebaseConfig`
   object with your project's real config (Firebase console → Project
   settings → General → Your apps → Web app → SDK setup and configuration)
   — same values as `extension/firebase-config.js`. Also confirm
   Authentication → Sign-in method → **Anonymous** is enabled (see step 3
   above); the dashboard signs in anonymously to call
   `addTestBlocklistEntry`.
2. Deploy the updated rules and functions, then hosting:
   ```bash
   cd backend
   firebase deploy --only firestore:rules,functions,hosting
   ```
   (`backend/firebase.json` already points hosting at `../dashboard`.)
3. Open the deployed dashboard URL (or `dashboard/index.html` locally via
   any static server — `file://` won't work with Firebase Auth). You
   should see:
   - Three counters (**Total scans**, **Total blocked**, **Total
     reported**) read from the public `stats/global` document.
   - A table of the 20 most-recently-added `blocklist` entries.
   - An **Add test blocklist entry** button that calls the
     `addTestBlocklistEntry` callable and adds
     `https://example-phishing.com` to the blocklist, refreshing the table.
4. To see the counters move, use the extension for a bit (each navigation
   calls `incrementScan`) and submit a report from the popup, then reload
   the dashboard. `reported_urls` itself is never read by the dashboard —
   it stays admin-only, per `firestore.rules`.

## 5. Mobile PWA (Android/iOS)

`mobile/` is a plain-JS, no-build-step Progressive Web App that lets users
check a link on their phone: paste a URL and tap **Check Link**, or (on
Android) share a link from any app (browser, WhatsApp, SMS, ...) straight
into SafeLink via the [Web Share Target
API](https://developer.mozilla.org/en-US/docs/Web/Manifest/share_target).
It runs the exact same heuristics engine as the extension
(`mobile/heuristics.js` is a duplicate of `extension/utils/heuristics.js`)
and talks to the same Firebase backend (`getBlocklist`, `reportUrl`) — no
separate backend is needed.

### Configure

1. Copy the same values from `extension/firebase-config.js` into
   `mobile/firebase-config.js`. As with the extension, leaving `apiKey`
   empty runs the PWA in local-only mode: heuristic checking still works,
   but blocklist sync and **Report as Scam** are disabled (a warning
   banner explains this in the UI).
2. In `mobile/app.js`, set `DASHBOARD_URL` to your deployed dashboard URL
   (same value as `extension/popup/popup.js`'s `DASHBOARD_URL`).
3. `mobile/icon-192.png` and `mobile/icon-512.png` are solid-color
   placeholders — swap them for real branded app icons before sharing the
   install link with real users (192×192 and 512×512 PNGs, referenced from
   `mobile/manifest.webmanifest`).

### Host it

Any static host over **HTTPS** works — the Web Share Target API requires
it, and `file://` won't run the service worker or Firebase Auth. Two easy
options:

- **Firebase Hosting** (same project as the backend): `backend/firebase.json`
  currently points `hosting.public` at `../dashboard` only. To serve
  `mobile/` from the same site, either change `hosting.public` to `..`
  (the `scam-blocker/` root, so both `/dashboard/` and `/mobile/` deploy
  together) and redeploy with `firebase deploy --only hosting`, or add a
  [second Hosting site](https://firebase.google.com/docs/hosting/multisites)
  dedicated to `mobile/`.
- **GitHub Pages / Netlify**: point either at the repo (or just the
  `mobile/` folder) and deploy — no build step required, since it's plain
  HTML/CSS/JS.

### Install and use on Android

1. Open the hosted URL in Chrome for Android.
2. Chrome menu (⋮) → **Add to Home screen** (or **Install app**, if
   Chrome offers the install prompt automatically).
3. Once installed, SafeLink appears as a registered **share target**: from
   any app's share sheet (browser, WhatsApp, SMS, etc.), share a link and
   pick **SafeLink** — it opens straight to the result for that URL
   (`mobile/app.js`'s `getSharedUrl()` reads the `url` query param the
   share target passes, falling back to a URL found inside `text`/`title`
   for apps that only share those).

**iOS Safari does not support the Web Share Target API**, so the "share
into the app" flow isn't available there — iOS users can still add the
PWA to their home screen and use the paste-and-check flow (copy a link,
open SafeLink, paste it into the input, tap **Check Link**).

## How detection works

- **Heuristics** (`extension/utils/heuristics.js`, `HeuristicsUtil.checkUrl(url, sensitivity)`):
  a weighted scoring engine, not a single boolean per rule. Signals
  include: a URL over 120 characters; a raw IP-address host; a
  commonly-abused TLD (`.tk`, `.ml`, `.xyz`, `.top`, `.club`, `.support`,
  `.info`, `.online`, etc.); more than 3 subdomains; an `@` symbol in the
  URL's authority (used to hide the real host); an excessive number of
  hyphens or digits in the domain; phishing-style keywords in the path,
  query, or host (`login`, `verify`, `account`, `bank`, `paypal`,
  `password`, `confirm`, `unlock`, `suspended`, `webscr`, `cmd`, etc.); a
  known brand name (`whirlpool`, `paypal`, `amazon`, `microsoft`, ...)
  appearing in the domain on a TLD that isn't `.com`/`.org`/`.net`/`.co`
  or an official country-code TLD (e.g. `whirlpool-service.support` vs.
  the real `whirlpool.com`); and non-standard/punycode ("xn--") characters
  in the hostname, which can indicate an IDN homograph (lookalike)
  domain. Each rule adds a weight to a score, and the **sensitivity**
  setting (see above) picks how high that score must get before the URL
  is treated as a scam.
- **Blocklist**: URLs reported 3+ times by distinct users are promoted to
  Firestore's `blocklist` collection by the `reportUrl` function, synced
  into the extension hourly.
- **Google Safe Browsing** (optional, see setup above): if enabled with a
  valid API key, `background.js`'s `checkWithSafeBrowsing()` calls the
  Safe Browsing Lookup API v4 for any URL that heuristics and the
  blocklist didn't already flag, and adds "Google Safe Browsing flagged
  this site" to the reasons if it returns a match. Results are cached in
  `chrome.storage.local` for 24 hours; a missing key or a failed request
  is treated as "not checked," never as an error.
- **Enforcement**: `background.js` checks every top-level navigation
  (`webNavigation.onBeforeNavigate`) against the temporary whitelist,
  heuristics, the local blocklist copy, and (if enabled) Safe Browsing, in
  that order; `content.js` additionally re-checks the URL on
  same-document (SPA) navigations that don't fire a `webNavigation` event.
  A match redirects the tab to `blockpage/block.html`, which shows the
  blocked URL and the specific reasons it was flagged, with **Back to
  safety** and **Proceed anyway** (behind a second confirmation) buttons.
  Proceeding whitelists that domain in `chrome.storage.local`
  (`temporaryWhitelist`) for 24 hours so it isn't immediately re-blocked.

## Notes / design tradeoffs

- The extension uses the real Firebase Auth SDK (compat build, loaded via
  `importScripts()` in `background.js`) and signs every user in
  anonymously on install/startup. `reportUrl` uses `context.auth.uid` from
  that session to track distinct reporters — no client-generated ids
  involved. See "Manifest V3 and remote code" above for the tradeoffs of
  loading the SDK from a CDN.
- The popup (`popup.js`) doesn't load the Firebase SDK itself. Reporting a
  URL sends a `REPORT_URL` message to `background.js`, which is already
  Firebase-initialized and holds the auth session — this keeps there being
  exactly one place in the extension that loads remote SDK code. For the
  same reason, the `incrementScan({ isReport: true })` stats call that
  fires after a successful report also lives in `background.js`
  (`reportUrlToFirebase`) rather than in `popup.js`.
- `reported_urls` documents are keyed by a stable id derived from the URL
  (base64 of the URL string) rather than being append-only, so repeated
  reports of the same URL accumulate on one document (`count` increments,
  `reportedBy` is a de-duplicated array of uids) instead of creating a new
  document per report.
- `chrome.alarms` (rather than `setInterval`) drives the hourly blocklist
  refresh, since MV3 service workers can be terminated at any time and
  `chrome.alarms` reliably survives worker restarts.
