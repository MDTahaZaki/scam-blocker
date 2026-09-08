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
└── dashboard/     Static dashboard (Chart.js), deployable to Firebase Hosting
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

## 3. Set up and deploy the dashboard (optional)

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

## How detection works

- **Heuristics** (`extension/utils/heuristics.js`): flags URLs that are
  over 100 characters, use a raw IP address, use a commonly-abused TLD
  (`.tk`, `.ml`, `.xyz`, `.top`, `.club`, etc.), have more than 3
  subdomains, contain an `@` symbol, have hyphens in the domain, or contain
  scam-related keywords (`login`, `verify`, `account`, `bank`, etc.).
- **Blocklist**: URLs reported 3+ times by distinct users are promoted to
  Firestore's `blocklist` collection by the `reportUrl` function, synced
  into the extension hourly.
- **Enforcement**: `background.js` checks every top-level navigation
  (`webNavigation.onBeforeNavigate`) against both the heuristics and the
  local blocklist copy; `content.js` additionally re-checks the URL on
  same-document (SPA) navigations that don't fire a `webNavigation` event.
  A match redirects the tab to `blockpage/block.html`, which shows the
  blocked URL and the specific reasons it was flagged.

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
