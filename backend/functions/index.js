const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const REPORTS_COLLECTION = 'reported_urls';
const BLOCKLIST_COLLECTION = 'blocklist';
const STATS_COLLECTION = 'stats';
const STATS_DOC = 'global';
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
 * Callable: incrementScan({ isScam, isReport })
 * Aggregate stats hook, written to a single `stats/global` document so the
 * public dashboard can read one doc instead of scanning `reported_urls`
 * (which is admin-only). Best-effort: failures are logged but never
 * surfaced to the caller, since stats must never block URL evaluation or
 * reporting.
 *
 * - `{ isReport: true }` (called after a successful reportUrl): increments
 *   `totalReported` only.
 * - Otherwise (called after every URL check): increments `totalScans`
 *   always, and `totalBlocked` too when `isScam` is true.
 */
exports.incrementScan = functions.https.onCall(async (data) => {
  const isReport = Boolean(data && data.isReport);
  const isScam = Boolean(data && data.isScam);

  const update = isReport
    ? { totalReported: FieldValue.increment(1) }
    : {
        totalScans: FieldValue.increment(1),
        totalBlocked: FieldValue.increment(isScam ? 1 : 0)
      };

  try {
    await db
      .collection(STATS_COLLECTION)
      .doc(STATS_DOC)
      .set(update, { merge: true });
  } catch (err) {
    console.error('incrementScan failed', err);
  }
  return { success: true };
});

/**
 * Callable: addTestBlocklistEntry()
 * Demo/testing helper for the dashboard: adds a fixed sample URL to the
 * public `blocklist` collection so the dashboard's blocklist table has
 * something to show without needing 3 real reports first. Requires an
 * authenticated caller (anonymous auth is fine) to keep it from being
 * abused by anonymous scripts hammering the endpoint; it is not otherwise
 * restricted to admins since it only ever writes one fixed, non-sensitive
 * document.
 */
exports.addTestBlocklistEntry = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'You must be signed in (anonymous auth is fine) to add a test entry.'
    );
  }

  const url = 'https://example-phishing.com';
  await db.collection(BLOCKLIST_COLLECTION).doc(urlToDocId(url)).set({
    url,
    date_added: FieldValue.serverTimestamp()
  });
  blocklistCache = { data: null, expiresAt: 0 }; // invalidate cache

  return { success: true, url };
});
