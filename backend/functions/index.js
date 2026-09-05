const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const REPORTS_COLLECTION = 'reported_urls';
const BLOCKLIST_COLLECTION = 'blocklist';
const STATS_COLLECTION = 'stats';
const REPORT_THRESHOLD = 3;
const BLOCKLIST_CACHE_MS = 5 * 60 * 1000;

// In-memory cache shared across warm invocations of getBlocklist.
let blocklistCache = { data: null, expiresAt: 0 };

// Derive a stable, Firestore-safe document id from a URL so repeated
// reports of the same URL accumulate on one document instead of creating
// duplicates.
function urlToDocId(url) {
  return Buffer.from(url).toString('base64').replace(/[/+=]/g, '_');
}

/**
 * Callable: reportUrl({ url })
 * Requires an authenticated caller (anonymous auth is fine). Records the
 * report on a per-URL document in `reported_urls`, tracking the set of
 * distinct reporter uids. Once 3+ distinct users have reported the same
 * URL, it is promoted into the public `blocklist` collection.
 */
exports.reportUrl = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'You must be signed in (anonymous auth is fine) to report a URL.'
    );
  }

  const url = String((data && data.url) || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new functions.https.HttpsError('invalid-argument', 'A valid http(s) url is required.');
  }

  const uid = context.auth.uid;
  const docId = urlToDocId(url);
  const reportRef = db.collection(REPORTS_COLLECTION).doc(docId);

  await reportRef.set(
    {
      url,
      timestamp: FieldValue.serverTimestamp(),
      uid,
      count: FieldValue.increment(1),
      // arrayUnion de-dupes automatically, so this doubles as the set of
      // distinct reporters used for the blocklist-promotion check below.
      reportedBy: FieldValue.arrayUnion(uid)
    },
    { merge: true }
  );

  const reportSnap = await reportRef.get();
  const reportedBy = (reportSnap.data() && reportSnap.data().reportedBy) || [];

  if (reportedBy.length >= REPORT_THRESHOLD) {
    const blocklistRef = db.collection(BLOCKLIST_COLLECTION).doc(docId);
    const blocklistSnap = await blocklistRef.get();
    if (!blocklistSnap.exists) {
      await blocklistRef.set({ url, date_added: FieldValue.serverTimestamp() });
      blocklistCache = { data: null, expiresAt: 0 }; // invalidate cache
    }
  }

  return { success: true, message: 'Report received. Thank you for helping keep the community safe.' };
});

/**
 * Callable: getBlocklist()
 * Public (no auth required). Returns the blocklist as a plain array of
 * URL strings, cached in-memory for 5 minutes to reduce Firestore reads.
 */
exports.getBlocklist = functions.https.onCall(async () => {
  const now = Date.now();
  if (!blocklistCache.data || blocklistCache.expiresAt < now) {
    const snap = await db.collection(BLOCKLIST_COLLECTION).get();
    const urls = snap.docs.map((doc) => doc.data().url).filter(Boolean);
    blocklistCache = { data: urls, expiresAt: now + BLOCKLIST_CACHE_MS };
  }
  return blocklistCache.data;
});

/**
 * Callable: incrementScan({ url, isDangerous })
 * Optional stats hook the extension can call whenever it evaluates a URL.
 * Best-effort: failures are logged but never surfaced to the caller.
 */
exports.incrementScan = functions.https.onCall(async (data) => {
  try {
    const isDangerous = Boolean(data && data.isDangerous);
    await db
      .collection(STATS_COLLECTION)
      .doc('scans')
      .set(
        {
          totalScans: FieldValue.increment(1),
          dangerousScans: FieldValue.increment(isDangerous ? 1 : 0),
          lastScanAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
  } catch (err) {
    console.error('incrementScan failed', err);
  }
  return { success: true };
});
