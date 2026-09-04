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
    timeTd.textContent = formatTimestamp(report.reportedAt);

    tr.appendChild(urlTd);
    tr.appendChild(timeTd);
    recentTableBody.appendChild(tr);
  });
}

function renderChart(reports, since) {
  const buckets = new Array(24).fill(0);
  const now = Date.now();

  reports.forEach((report) => {
    if (!report.reportedAt || !report.reportedAt.toDate) return;
    const reportedAt = report.reportedAt.toDate().getTime();
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

async function loadDashboard() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  try {
    const [reportsSnap, blocklistSnap] = await Promise.all([
      db
        .collection('reported_urls')
        .where('reportedAt', '>=', since)
        .orderBy('reportedAt', 'desc')
        .get(),
      db.collection('blocklist').get()
    ]);

    const reports = reportsSnap.docs.map((doc) => doc.data());

    reports24hEl.textContent = reports.length;
    totalBlocklistEl.textContent = blocklistSnap.size;

    renderRecentTable(reports);
    renderChart(reports, since);
  } catch (err) {
    console.error('Failed to load dashboard data', err);
    recentTableBody.innerHTML = `<tr><td colspan="2">Failed to load data: ${err.message}</td></tr>`;
  }
}

loadDashboard();
