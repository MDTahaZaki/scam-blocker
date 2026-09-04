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

## 1. Set up Firebase

1. Go to the [Firebase console](https://console.firebase.google.com/) and
   create a new project.
2. Enable **Firestore Database** (production mode is fine — rules are
   provided in `backend/firestore.rules`).
3. Install the Firebase CLI if you don't have it:
   ```bash
   npm install -g firebase-tools
   firebase login
   ```
4. From `backend/`, point the CLI at your project:
   ```bash
   cd backend
   firebase use --add
   # select your project, give it an alias (e.g. "default")
   ```

## 2. Deploy the Cloud Functions

```bash
cd backend/functions
npm install
cd ..
firebase deploy --only functions,firestore:rules
```

After deploying, note the base URL Firebase prints for your functions, e.g.:

```
https://us-central1-your-project-id.cloudfunctions.net
```

You'll get three endpoints:
- `POST /reportUrl` — `{ url, uid }` — records a report; auto-blocklists a
  URL once 3 distinct anonymous uids have reported it.
- `GET /getBlocklist` — returns `{ blocklist: string[] }`, cached 5 minutes.
- `POST /incrementScan` — `{ url, isDangerous }` — optional scan counter.

## 3. Point the extension at your Firebase project

Edit these two files and replace `FUNCTIONS_BASE_URL` with the URL from
step 2:

- `extension/background.js`
- `extension/popup/popup.js` (also set `DASHBOARD_URL` here if you deploy
  the dashboard via Firebase Hosting in step 5)

## 4. Load the extension in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Pin the extension and open a page — the popup will show whether the
   current page looks safe, and a "Report this site as scam" button submits
   the current URL to `reportUrl`.
5. The blocklist is fetched from `getBlocklist` on install/startup and every
   hour afterward, and cached in `chrome.storage.local`.

## 5. Set up and deploy the dashboard (optional)

1. In `dashboard/dashboard.js`, replace the placeholder `firebaseConfig`
   object with your project's real config (Firebase console → Project
   settings → General → Your apps → Web app → SDK setup and configuration).
2. Deploy as static hosting, e.g. with Firebase Hosting:
   ```bash
   cd backend
   firebase deploy --only hosting
   ```
   (`backend/firebase.json` already points hosting at `../dashboard`.)
3. The dashboard reads `reported_urls` and `blocklist` directly from
   Firestore (public read, per `firestore.rules`) — no backend calls needed.

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

- The extension doesn't use the Firebase Auth SDK (kept dependency-free, no
  build step). Instead it generates a random UUID on first use, stored in
  `chrome.storage.local`, and sends it as `uid` on reports — this is what
  `reportUrl` uses to count distinct reporters. Firestore's
  `reported_urls` write rule requires Firebase Auth, which only the trusted
  `reportUrl` Cloud Function (via the Admin SDK, which bypasses security
  rules) actually writes through.
- The extension manifest includes the `alarms` permission in addition to
  the ones listed in the spec — MV3 service workers can be terminated at
  any time, so `chrome.alarms` (rather than `setInterval`) is required for
  the hourly blocklist refresh to reliably survive worker restarts.
