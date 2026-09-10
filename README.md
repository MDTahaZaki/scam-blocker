# SafeLink AI (Scam Link Detector)

A Chrome (Manifest V3) extension, mobile PWA, and small Firebase backend
that detect and block scam/phishing links using local heuristics, an
optional Google Safe Browsing lookup, and a crowd-reported blocklist — with
a read-only dashboard for the aggregate stats.

This is a working prototype, not a production security product: it's
honest, weighted-heuristic scam detection plus a community blocklist, built
and hardened over a short build sprint (see [Limitations](#limitations)
below for exactly where it falls short of that).

## Features

- **Local heuristic scoring** — a weighted rules engine
  (`extension/utils/heuristics.js`) flags raw IP-address hosts, commonly
  abused TLDs, `@`-symbol authority tricks, excessive subdomains/hyphens/
  digits, phishing keywords, brand impersonation on the wrong domain, fake
  tech-support subdomains, and IDN homograph domains — no network call
  required, and no per-URL cost.
- **Crowd-sourced blocklist** — URLs reported by 3+ distinct users are
  promoted into a public Firestore `blocklist` collection, synced into the
  extension and PWA hourly.
- **Optional Google Safe Browsing lookup** — supplements heuristics with
  Google's Safe Browsing Lookup API v4 for URLs local checks didn't already
  flag, with a 24h result cache to keep quota usage low.
- **Adjustable sensitivity** — Low/Medium/High controls how many/how strong
  the heuristic signals need to be before a page is blocked.
- **Block page with an escape hatch** — a full-page interstitial explaining
  exactly why a page was flagged, with a double-confirmed "proceed anyway"
  that temporarily whitelists the domain for 24h.
- **One-click reporting** — report a suspicious page from the extension
  popup or the mobile PWA; reports are rate-limited server-side.
- **Public dashboard** — total scans, total blocked, total reported, and
  the current blocklist, read from a single public Firestore document (no
  admin data ever exposed to clients).
- **Mobile PWA** — paste-and-check on any device, plus an Android Web Share
  Target so you can share a link straight from WhatsApp/SMS/a browser into
  a scam check.

## Screenshots

_Add screenshots here before sharing this repo publicly — none are
committed yet._

- `docs/screenshots/popup-safe.png` — popup showing a safe page.
- `docs/screenshots/popup-danger.png` — popup showing a flagged page.
- `docs/screenshots/block-page.png` — the full-page block interstitial.
- `docs/screenshots/dashboard.png` — the stats dashboard.
- `docs/screenshots/mobile-pwa.png` — the mobile PWA's check screen.

## Architecture

```
                     ┌───────────────────────────┐
                     │   Chrome Extension (MV3)   │
  navigation/paste →│  content.js / background.js │
                     │                             │
                     │  1. Heuristics (local, free)│
                     │  2. Blocklist (cached copy) │
                     │  3. Safe Browsing (optional)│
                     └───────────────┬─────────────┘
                                     │ match found
                                     ▼
                       ┌─────────────────────────┐
                       │   Block Page             │
                       │   (blockpage/block.html) │
                       └────────────┬──────────────┘
                                    │ user clicks "Report this site"
                                    ▼
                     ┌──────────────────────────────┐
                     │  Firebase Cloud Functions     │
                     │  reportUrl / getBlocklist /   │
                     │  incrementScan                │
                     └───────────────┬────────────────┘
                                     │
                                     ▼
                     ┌──────────────────────────────┐
                     │  Firestore                    │
                     │  reported_urls (admin-only)    │
                     │  blocklist (public read)       │
                     │  stats/global (public read)    │
                     │  report_log (admin-only,        │
                     │              rate-limit)        │
                     └───────────────┬────────────────┘
                                     │
                                     ▼
                     ┌──────────────────────────────┐
                     │  Dashboard (static site)       │
                     │  reads stats + blocklist        │
                     └──────────────────────────────┘

The Mobile PWA (mobile/) runs the same heuristics engine and calls the
same Cloud Functions independently — it is not routed through the
extension.
```

Data flow in one line: **Extension → Heuristics → Blocklist (Firebase) →
Safe Browsing → Block Page → User Report → Firebase → Dashboard.**

## Project structure

```
scam-blocker/
├── extension/            Chrome MV3 extension (load unpacked)
│   ├── background.js       Service worker: nav interception, blocklist sync, Safe Browsing
│   ├── content.js           SPA-navigation re-check
│   ├── manifest.json
│   ├── utils/heuristics.js  Weighted scam-scoring engine (also require()-able by tests)
│   ├── popup/                Toolbar popup (status + report + settings)
│   └── blockpage/             Full-page block interstitial
├── backend/               Firebase Cloud Functions + Firestore rules
│   ├── functions/index.js   reportUrl, getBlocklist, incrementScan, addTestBlocklistEntry
│   ├── firestore.rules
│   └── firestore.indexes.json
├── dashboard/             Static dashboard (deployable to Firebase Hosting)
├── mobile/                Installable PWA (paste-and-check + Android share target)
│   └── heuristics.js        Duplicate of extension/utils/heuristics.js (see note below)
├── tests/                 Jest tests for the heuristics engine
├── scripts/build-extension.sh   Zips extension/ for manual install / future Web Store upload
├── .github/workflows/test.yml   CI: npm install && npm test on every push/PR
└── TESTING.md              Manual test checklist (extension, dashboard, PWA, backend)
```

`mobile/heuristics.js` is a deliberate duplicate of
`extension/utils/heuristics.js` (same logic, different header comment) so
the PWA needs no build step or import path back into `extension/`. **If you
change the detection rules, update both files** — `tests/heuristics.test.js`
only exercises the `extension/` copy, so a drift between the two would not
be caught automatically.

## Setup

### Prerequisites

- Node.js 18+ (for running tests and, optionally, the Firebase CLI)
- Google Chrome (or any Chromium-based browser) for the extension
- A Firebase project (free Spark plan works for everything except Cloud
  Functions, which needs the pay-as-you-go Blaze plan — see below)

### 1. Firebase setup

1. Create a project at the [Firebase console](https://console.firebase.google.com/).
2. Enable **Firestore Database** (rules are provided in
   `backend/firestore.rules` — deploy them, don't hand-edit in the console).
3. Enable **Authentication → Sign-in method → Anonymous**. Every client
   (extension and PWA) signs in anonymously so `reportUrl` can attribute
   reports to a stable `uid`.
4. Enable **Cloud Functions** (requires the Blaze plan; the included free
   quota covers this project's typical traffic).
5. Install the Firebase CLI and link the project:
   ```bash
   npm install -g firebase-tools
   firebase login
   cd backend
   firebase use --add   # select your project, e.g. alias "default"
   ```
6. Install function dependencies and deploy rules, indexes, and functions:
   ```bash
   cd backend/functions
   npm install
   cd ..
   firebase deploy --only firestore:rules,firestore:indexes,functions
   ```
7. In **Project settings → General → Your apps**, add a **Web app** and
   copy the resulting config object.
8. Paste those values into `extension/firebase-config.js` (and, for the
   PWA and dashboard, `mobile/firebase-config.js` and
   `dashboard/dashboard.js`):
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
   Leaving `apiKey` empty (the shipped default) runs everything in
   **local-only mode**: heuristics still work, but blocklist sync and
   reporting are disabled until this is filled in.

### 2. Extension setup

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select `extension/`.
2. Pin the extension and open any page — the popup shows whether it looks
   safe, with a **Report this site as scam** button (disabled on internal
   `chrome://`/`about:` pages, which can't be reported).
3. The blocklist syncs on install/startup and hourly afterward
   (`chrome.alarms`), cached in `chrome.storage.local`.
4. Optional: in the popup's **Settings** tab, enable **Google Safe
   Browsing** with an API key from the
   [Safe Browsing API console](https://console.cloud.google.com/apis/library/safebrowsing.googleapis.com),
   and adjust **Detection sensitivity** (Low/Medium/High).

### 3. Mobile PWA setup

1. Copy the same Firebase config into `mobile/firebase-config.js`.
2. Set `DASHBOARD_URL` in `mobile/app.js` (and `extension/popup/popup.js`)
   to your deployed dashboard URL.
3. Replace the placeholder `mobile/icon-192.png` / `icon-512.png` with real
   app icons before sharing an install link.
4. Deploy `mobile/` to any static HTTPS host — Firebase Hosting (same
   project) works well; see the existing `backend/firebase.json` and point
   `hosting.public` at the repo root (or add a
   [second Hosting site](https://firebase.google.com/docs/hosting/multisites))
   so both `dashboard/` and `mobile/` deploy together. HTTPS is required —
   the Web Share Target API and Firebase Auth don't work over `file://`.
5. On Android Chrome: menu → **Add to Home screen** (or accept the install
   prompt). Once installed, SafeLink appears in the share sheet of any app
   — sharing a link opens straight to its scan result.

### 4. Dashboard setup

1. Paste the Firebase config into `dashboard/dashboard.js`.
2. Deploy hosting alongside rules/functions:
   ```bash
   cd backend
   firebase deploy --only firestore:rules,functions,hosting
   ```
3. Open the deployed URL (or serve `dashboard/` locally over any static
   server — not `file://`, since Firebase Auth needs a real origin).

## Running tests

```bash
npm install
npm test
```

This runs the Jest suite in `tests/heuristics.test.js` against
`extension/utils/heuristics.js` (27 cases: legitimate URLs, IP-address
hosts, suspicious TLDs, `@`-authority tricks, excessive subdomains/
hyphens/digits, phishing keywords, brand impersonation, the fake
tech-support subdomain pattern, IDN homographs, very long URLs, and
malformed/empty/null input). CI runs the same command on every push and
pull request via `.github/workflows/test.yml`.

Everything else — the extension UI, backend behavior end-to-end, dashboard,
and PWA — is covered by the manual checklist in [`TESTING.md`](TESTING.md),
not by automated tests.

## Packaging the extension

```bash
./scripts/build-extension.sh
```

Zips `extension/` into `dist/safelink-ai-v<version>.zip` (version read from
`manifest.json`). This gives you a file that can be side-loaded elsewhere
or uploaded to the Chrome Web Store **once the Firebase SDK is vendored
locally** — see Limitations below. Requires `zip` on your `PATH` (present
on Linux/macOS and in GitHub Actions' `ubuntu-latest`; on Windows, run it
under WSL or Git Bash with `zip` installed, e.g. via `pacman`/`choco`).

## Security notes

- **Firestore rules** (`backend/firestore.rules`): `reported_urls` and
  `report_log` deny all client read/write (Cloud Functions use the Admin
  SDK, which bypasses rules); `blocklist` and `stats` are public-read,
  deny-all-write. Direct client writes to any collection are always
  rejected — every write goes through a callable function.
- **Input validation**: every callable that accepts a URL
  (`assertValidUrl` in `backend/functions/index.js`) rejects non-string,
  >2000-character, or non-http(s) input with `HttpsError('invalid-argument', ...)`
  before touching Firestore.
- **Rate limiting**: `reportUrl` rejects a caller who has already logged 10
  reports in the last hour (tracked in the admin-only `report_log`
  collection) with `HttpsError('resource-exhausted', ...)`. This limits
  report volume per Firebase Auth uid, not per person — an attacker who
  re-signs-in anonymously gets a fresh uid and a fresh quota. It raises the
  cost of blocklist-spamming a URL (each promotion still needs 3 distinct
  uids); it does not eliminate it.
- **Firebase config in the client**: `extension/firebase-config.js`,
  `mobile/firebase-config.js`, and `dashboard/dashboard.js` contain a
  Firebase Web SDK config (`apiKey` etc.). This is not a secret — it's a
  public client identifier, and access is enforced by Firestore rules and
  App Check-style domain/extension restrictions, not by hiding the key.
  It's fine to commit as-is for this project's scope; a larger production
  deployment would typically still keep it out of version control and
  inject it via a build step, mainly to make rotating it easier.
- **CSP / remote code**: `extension/manifest.json`'s
  `content_security_policy` allows `script-src https://www.gstatic.com` so
  `background.js` can `importScripts()` the Firebase compat SDK from
  Google's CDN. This works for local development and side-loading, but
  **Chrome Web Store review prohibits remotely-hosted code** — before
  submitting there, vendor the SDK files locally (e.g. under
  `extension/vendor/firebase/`), update the `importScripts()` paths, and
  remove the CSP override.
- **Popup report button**: disabled whenever the active tab's URL isn't
  `http:`/`https:` (e.g. `chrome://`, `about:`, `chrome-extension://`),
  since those pages have no meaningful scam verdict and can't be reported.

## How detection works

- **Heuristics** (`extension/utils/heuristics.js`,
  `HeuristicsUtil.checkUrl(url, sensitivity)`): a weighted scoring engine,
  not a single boolean per rule. Signals include a URL over 120 characters;
  a raw IP-address host; a commonly-abused TLD (`.tk`, `.ml`, `.xyz`,
  `.top`, `.info`, `.online`, etc.); more than 3 subdomains; an `@` symbol
  in the authority (hides the real host); excessive hyphens/digits in the
  domain; phishing-style keywords in host/path/query (`login`, `verify`,
  `bank`, `password`, `suspended`, ...); a known brand name appearing
  anywhere in the hostname on a domain that isn't that brand's official
  one (`findBrandImpersonation` — see below); a support/service-style
  subdomain (`support`, `helpdesk`, `care`, ...) sitting on an unusual TLD
  (`findSupportSubdomainScam` — the rule added specifically to catch the
  real-world `vice-support.servicediy.in` scam, which used none of the
  other signals strongly enough on its own); and non-standard/punycode
  ("xn--") hostname characters, which can indicate an IDN homograph
  domain. Each rule adds a weight to a score, and the **sensitivity**
  setting picks how high that score must get before the URL counts as a
  scam (see `SENSITIVITY_THRESHOLDS` in the file).
- **Blocklist**: URLs reported 3+ times by distinct users are promoted to
  Firestore's `blocklist` collection by `reportUrl`, synced into the
  extension and PWA hourly.
- **Google Safe Browsing** (optional): if enabled with a valid API key,
  `background.js` calls the Safe Browsing Lookup API v4 for any URL
  heuristics and the blocklist didn't already flag, caching results for
  24h. A missing key or failed request is treated as "not checked," never
  as an error.
- **Enforcement**: `background.js` checks every top-level navigation
  against the temporary whitelist, heuristics, the local blocklist copy,
  and (if enabled) Safe Browsing, in that order; `content.js` re-checks on
  same-document (SPA) navigations. A match redirects to
  `blockpage/block.html`, which lists the specific reasons and offers
  **Back to safety** or a double-confirmed **Proceed anyway** (whitelists
  the domain for 24h in `chrome.storage.local`).

## Limitations

Read this before treating any of the below as more solid than it is:

- **No trained ML model.** Everything is hand-written, weighted rules —
  there's no classifier trained on real phishing data. It'll miss scams
  that don't match any rule and will occasionally flag legitimate sites
  that happen to match several.
- **The brand-impersonation rule is fragile.** It only exempts a brand's
  exact official domain (e.g. `amazon.com`) — legitimate regional domains
  like `amazon.co.uk` or `amazon.de` are *not* recognized and will be
  flagged as impersonation. This is a deliberate tradeoff: an earlier
  version exempted any two-letter country-code TLD, which is exactly the
  trick the real `vice-support.servicediy.in` scam used (a `.in` domain) to
  look legitimate, so that blanket exemption was removed. The brand list
  itself is also short (`extension/utils/heuristics.js`'s
  `OFFICIAL_DOMAINS`) and easy to bypass by simply not including a listed
  brand name in the domain.
- **The support-subdomain rule (`findSupportSubdomainScam`) is a narrow,
  targeted fix, not a general solution.** It flags any `support`/`service`/
  `helpdesk`/etc. subdomain sitting on a TLD outside a short trusted list
  (`.com`, `.org`, `.net`, `.co`, `.gov`, `.edu`). That will false-positive
  on legitimate regional businesses (e.g. a real `support.company.in`) and
  can still be evaded by using a different subdomain word or a trusted TLD.
- **Mobile support is limited to a PWA.** There's no native Android app —
  the PWA covers paste-and-check and Android's Web Share Target, but iOS
  Safari doesn't support Web Share Target, so sharing into the app isn't
  available there (paste-and-check still works).
- **The extension can't pass Chrome Web Store review as-is.** It loads the
  Firebase SDK from a CDN at runtime, which the Store's remote-code policy
  prohibits — see "CSP / remote code" above. Packaging with
  `scripts/build-extension.sh` produces an installable zip today, but not
  a Store-submittable one until the SDK is vendored locally.
- **Rate limiting is per-Firebase-uid, not per-person** (see Security notes
  above) — trivially bypassed by an attacker willing to re-authenticate
  anonymously.
- **No automated coverage beyond the heuristics engine.** The backend
  functions, extension UI, dashboard, and PWA are only verified by the
  manual checklist in `TESTING.md`.

## Roadmap

- Train a real ML classifier on a labeled phishing/scam URL dataset,
  replacing (or supplementing) the hand-written heuristics.
- Native Android app (beyond the current PWA), for deeper share-sheet and
  notification integration.
- Firefox and Safari support (the current extension is Chrome MV3-only).
- Vendor the Firebase SDK locally and submit to the Chrome Web Store.

## Contributing

Issues and pull requests are welcome. Before opening a PR: run `npm test`,
and if you touched `extension/utils/heuristics.js`, update
`mobile/heuristics.js` to match (see the note in Project structure) and
walk through the relevant section of `TESTING.md`.

## License

[MIT](LICENSE)
