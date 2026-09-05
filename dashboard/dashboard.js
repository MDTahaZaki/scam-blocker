// Replace with your own Firebase project config (Project settings -> General
// -> Your apps -> SDK setup and configuration). This is a placeholder demo
// config and will not work until you swap in real values.
const firebaseConfig = {
  apiKey: 'DEMO_API_KEY',
  authDomain: 'demo-project.firebaseapp.com',
  projectId: 'demo-project',
  storageBucket: 'demo-project.appspot.com',
  messagingSenderId: '000000000000',
  appId: '1:000000000000:web:demoappid'
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

const reports24hEl = document.getElementById('reports-24h');
const totalBlocklistEl = document.getElementById('total-blocklist');
const recentTableBody = document.getElementById('recent-table-body');

function formatTimestamp(ts) {
  if (!ts || !ts.toDate) return '—';
  return ts.toDate().toLocaleString();
}

function renderRecentTable(reports) {
  recentTableBody.innerHTML = '';

  if (reports.length === 0) {
    recentTableBody.innerHTML = '<tr><td colspan="2">No reports yet.</td></tr>';
    return;
  }

  reports.slice(0, 20).forEach((report) => {
    const tr = document.createElement('tr');

    const urlTd = document.createElement('td');
    urlTd.textContent = report.url;

    const timeTd = document.createElement('td');
    timeTd.textContent = formatTimestamp(report.timestamp);

    tr.appendChild(urlTd);
    tr.appendChild(timeTd);
    recentTableBody.appendChild(tr);
  });
}

function renderChart(reports, since) {
  const buckets = new Array(24).fill(0);
  const now = Date.now();

  reports.forEach((report) => {
    if (!report.timestamp || !report.timestamp.toDate) return;
    const reportedAt = report.timestamp.toDate().getTime();
    const hoursAgo = Math.floor((now - reportedAt) / (60 * 60 * 1000));
    if (hoursAgo >= 0 && hoursAgo < 24) {
      buckets[23 - hoursAgo] += 1;
    }
  });

  const labels = buckets.map((_, i) => `${23 - i}h ago`).reverse();

  new Chart(document.getElementById('reports-chart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Reports',
          data: buckets,
          backgroundColor: '#d9342b'
        }
      ]
    },
    options: {
      responsive: true,
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 } }
      },
      plugins: {
        legend: { display: false }
      }
    }
  });
}

// `blocklist` is publicly readable (see backend/firestore.rules), but
// `reported_urls` is now locked down to Cloud-Function-only access — no
// client, including this dashboard, can read it directly any more. That
// query is expected to fail with permission-denied until a dedicated
// dashboard-facing callable (e.g. getRecentReports) is added; the blocklist
// stats still load normally in the meantime.
async function loadDashboard() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  try {
    const blocklistSnap = await db.collection('blocklist').get();
    totalBlocklistEl.textContent = blocklistSnap.size;
  } catch (err) {
    console.error('Failed to load blocklist', err);
    totalBlocklistEl.textContent = '—';
  }

  try {
    const reportsSnap = await db
      .collection('reported_urls')
      .where('timestamp', '>=', since)
      .orderBy('timestamp', 'desc')
      .get();

    const reports = reportsSnap.docs.map((doc) => doc.data());
    reports24hEl.textContent = reports.length;
    renderRecentTable(reports);
    renderChart(reports, since);
  } catch (err) {
    console.warn('reported_urls is not directly readable by clients (expected — see firestore.rules):', err.message);
    reports24hEl.textContent = '—';
    recentTableBody.innerHTML =
      '<tr><td colspan="2">Recent-reports view requires a dashboard-facing Cloud Function (not yet implemented).</td></tr>';
  }
}

loadDashboard();
