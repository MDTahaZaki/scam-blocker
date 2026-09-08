// Replace with your own Firebase project config (Project settings -> General
// -> Your apps -> SDK setup and configuration). This is a placeholder demo
// config and will not work until you swap in real values — same config
// object as extension/firebase-config.js.
const firebaseConfig = {
  apiKey: 'DEMO_API_KEY',
  authDomain: 'demo-project.firebaseapp.com',
  projectId: 'demo-project',
  storageBucket: 'demo-project.appspot.com',
  messagingSenderId: '000000000000',
  appId: '1:000000000000:web:demoappid'
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
const cloudFunctions = firebase.functions();

const statScansEl = document.getElementById('stat-scans');
const statBlockedEl = document.getElementById('stat-blocked');
const statReportedEl = document.getElementById('stat-reported');
const blocklistTableBody = document.getElementById('blocklist-table-body');
const addTestEntryBtn = document.getElementById('add-test-entry-btn');
const addTestEntryMessage = document.getElementById('add-test-entry-message');

function formatTimestamp(ts) {
  if (!ts || !ts.toDate) return '—';
  return ts.toDate().toLocaleString();
}

function formatCount(value) {
  return typeof value === 'number' ? value.toLocaleString() : '0';
}

// `addTestBlocklistEntry` requires an authenticated caller (see
// backend/functions/index.js), so the dashboard signs in anonymously the
// same way the extension does — no login UI needed for this demo.
function ensureSignedIn() {
  return new Promise((resolve) => {
    const unsubscribe = auth.onAuthStateChanged((user) => {
      unsubscribe();
      if (user) {
        resolve(user);
        return;
      }
      auth
        .signInAnonymously()
        .then((credential) => resolve(credential.user))
        .catch((err) => {
          console.warn('Anonymous sign-in failed:', err && err.message);
          resolve(null);
        });
    });
  });
}

// `stats/global` is public read (see backend/firestore.rules) and written
// only by the incrementScan Cloud Function.
async function loadStats() {
  try {
    const snap = await db.collection('stats').doc('global').get();
    const stats = snap.data() || {};
    statScansEl.textContent = formatCount(stats.totalScans);
    statBlockedEl.textContent = formatCount(stats.totalBlocked);
    statReportedEl.textContent = formatCount(stats.totalReported);
  } catch (err) {
    console.error('Failed to load stats/global', err);
    statScansEl.textContent = '—';
    statBlockedEl.textContent = '—';
    statReportedEl.textContent = '—';
  }
}

function renderBlocklistTable(entries) {
  blocklistTableBody.innerHTML = '';

  if (entries.length === 0) {
    blocklistTableBody.innerHTML = '<tr><td colspan="2">No blocklist entries yet.</td></tr>';
    return;
  }

  entries.forEach((entry) => {
    const tr = document.createElement('tr');

    const urlTd = document.createElement('td');
    urlTd.textContent = entry.url;

    const dateTd = document.createElement('td');
    dateTd.textContent = formatTimestamp(entry.date_added);

    tr.appendChild(urlTd);
    tr.appendChild(dateTd);
    blocklistTableBody.appendChild(tr);
  });
}

// `blocklist` is public read (see backend/firestore.rules).
async function loadBlocklist() {
  try {
    const snap = await db.collection('blocklist').orderBy('date_added', 'desc').limit(20).get();
    renderBlocklistTable(snap.docs.map((doc) => doc.data()));
  } catch (err) {
    console.error('Failed to load blocklist', err);
    blocklistTableBody.innerHTML = '<tr><td colspan="2">Failed to load blocklist.</td></tr>';
  }
}

function loadDashboard() {
  loadStats();
  loadBlocklist();
}

async function addTestBlocklistEntry() {
  addTestEntryBtn.disabled = true;
  addTestEntryMessage.classList.remove('error');
  addTestEntryMessage.textContent = 'Adding test entry…';
  addTestEntryMessage.hidden = false;

  try {
    const user = await ensureSignedIn();
    if (!user) throw new Error('Could not authenticate with Firebase.');

    const addEntry = cloudFunctions.httpsCallable('addTestBlocklistEntry');
    const result = await addEntry();

    addTestEntryMessage.textContent = `Added ${result.data.url} to the blocklist.`;
    await loadBlocklist();
  } catch (err) {
    addTestEntryMessage.textContent = (err && err.message) || 'Failed to add test entry.';
    addTestEntryMessage.classList.add('error');
  } finally {
    addTestEntryBtn.disabled = false;
  }
}

addTestEntryBtn.addEventListener('click', addTestBlocklistEntry);
loadDashboard();
