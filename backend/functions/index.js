const functions = require('firebase-functions');
const admin = require('firebase-admin');
const cors = require('cors')({ origin: true });

admin.initializeApp();
const db = admin.firestore();

const REPORTS_COLLECTION = 'reported_urls';
const BLOCKLIST_COLLECTION = 'blocklist';
const STATS_COLLECTION = 'stats';
const REPORT_THRESHOLD = 3;
const BLOCKLIST_CACHE_MS = 5 * 60 * 1000;

// Derive a Firestore-safe document id from a URL.
function urlToDocId(url) {
  return Buffer.from(url).toString('base64').replace(/[/+=]/g, '_');
}

function normalizeUrl(url) {
  return String(url || '').trim();
}

// In-memory cache shared across warm invocations of getBlocklist.
let blocklistCache = { data: null, expiresAt: 0 };

/**
 * POST /reportUrl  { url: string, uid?: string }
 * Records a report for a URL. Once a URL has been reported by 3+ distinct
 * anonymous uids, it is promoted into the public blocklist.
 */
exports.reportUrl = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const url = normalizeUrl(req.body && req.body.url);
    if (!url || !/^https?:\/\//i.test(url)) {
      res.status(400).json({ error: 'A valid http(s) url is required' });
      return;
    }

    // The extension has no build step and does not use the Firebase Auth
    // client SDK, so it generates and persists its own anonymous uid
    // (a random UUID stored in chrome.storage.local) and sends it here.
    const uid = normalizeUrl(req.body && req.body.uid) || `anon-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    try {
      await db.collection(REPORTS_COLLECTION).add({
        url,
        uid,
        reportedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const reportsSnap = await db
        .collection(REPORTS_COLLECTION)
        .where('url', '==', url)
        .get();

      const distinctUids = new Set(reportsSnap.docs.map((doc) => doc.data().uid));

      let blocked = false;
      if (distinctUids.size >= REPORT_THRESHOLD) {
        const docId = urlToDocId(url);
        await db.collection(BLOCKLIST_COLLECTION).doc(docId).set(
          {
            url,
            addedAt: admin.firestore.FieldValue.serverTimestamp(),
            reportCount: distinctUids.size
          },
          { merge: true }
        );
        blocked = true;
        blocklistCache = { data: null, expiresAt: 0 }; // invalidate cache
      }

      res.status(200).json({ success: true, reportCount: distinctUids.size, addedToBlocklist: blocked });
    } catch (err) {
      console.error('reportUrl failed', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });
});

/**
 * GET /getBlocklist
 * Returns { blocklist: string[] }, cached in-memory for 5 minutes.
 */
exports.getBlocklist = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const now = Date.now();
      if (!blocklistCache.data || blocklistCache.expiresAt < now) {
        const snap = await db.collection(BLOCKLIST_COLLECTION).get();
        const urls = snap.docs.map((doc) => doc.data().url).filter(Boolean);
        blocklistCache = { data: urls, expiresAt: now + BLOCKLIST_CACHE_MS };
      }

      res.set('Cache-Control', 'public, max-age=300');
      res.status(200).json({ blocklist: blocklistCache.data });
    } catch (err) {
      console.error('getBlocklist failed', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });
});

/**
 * POST /incrementScan  { url: string, isDangerous: boolean }
 * Optional stats endpoint called by the extension on every navigation check.
 */
exports.incrementScan = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const isDangerous = Boolean(req.body && req.body.isDangerous);
      const statsRef = db.collection(STATS_COLLECTION).doc('scans');
      await statsRef.set(
        {
          totalScans: admin.firestore.FieldValue.increment(1),
          dangerousScans: admin.firestore.FieldValue.increment(isDangerous ? 1 : 0),
          lastScanAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      res.status(200).json({ success: true });
    } catch (err) {
      console.error('incrementScan failed', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });
});
