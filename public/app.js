'use strict';

// ── Chart defaults ────────────────────────────────────────────────────────────

Chart.defaults.color = '#444';
Chart.defaults.borderColor = '#1c1c1c';
Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
Chart.defaults.font.size = 11;

function baseOptions(yConfig = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 400 },
    plugins: { legend: { display: false } },
    scales: {
      x: {
        grid: { color: '#181818' },
        ticks: { color: '#3e3e3e', maxTicksLimit: 10, maxRotation: 0 },
      },
      y: {
        grid: { color: '#181818' },
        ticks: { color: '#3e3e3e' },
        ...yConfig,
      },
    },
    elements: {
      point: { radius: 2.5, hoverRadius: 5, borderWidth: 0 },
      line: { borderWidth: 1.5 },
    },
  };
}

function lineDataset(data, color) {
  return {
    data,
    borderColor: color,
    backgroundColor: 'transparent',
    pointBackgroundColor: color,
    tension: 0.35,
    spanGaps: false,
  };
}

function fmtPace(minPerKm) {
  if (minPerKm == null) return '—';
  const m = Math.floor(minPerKm);
  const s = String(Math.round((minPerKm - m) * 60)).padStart(2, '0');
  return `${m}:${s}`;
}

function dateLabel(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
}

// ── Connection buttons + refresh ──────────────────────────────────────────────

function renderConnections(status) {
  const el = document.getElementById('connections');
  el.innerHTML = '';

  function serviceGroup(name, logoutPath) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;gap:4px;align-items:center';

    const badge = document.createElement('span');
    badge.className = 'btn connected';
    badge.innerHTML = `<span class="dot"></span>${name}`;
    wrap.appendChild(badge);

    const disc = document.createElement('a');
    disc.className = 'btn disconnect';
    disc.href = logoutPath;
    disc.textContent = '×';
    disc.title = `Disconnect ${name}`;
    wrap.appendChild(disc);

    return wrap;
  }

  if (status.strava) {
    el.appendChild(serviceGroup('Strava', '/auth/logout/strava'));
  } else {
    const btn = document.createElement('a');
    btn.className = 'btn';
    btn.href = '/auth/strava';
    btn.textContent = 'Connect Strava';
    el.appendChild(btn);
  }

  if (status.fitbit) {
    el.appendChild(serviceGroup('Fitbit', '/auth/logout/fitbit'));
  } else {
    const btn = document.createElement('a');
    btn.className = 'btn';
    btn.href = '/auth/fitbit';
    btn.textContent = 'Connect Fitbit';
    el.appendChild(btn);
  }

  if (status.strava || status.fitbit) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.id = 'refresh-btn';
    btn.textContent = 'Refresh';
    btn.addEventListener('click', handleRefresh);
    el.appendChild(btn);

    const resyncBtn = document.createElement('button');
    resyncBtn.className = 'btn';
    resyncBtn.id = 'resync-btn';
    resyncBtn.textContent = 'Resync all';
    resyncBtn.title = 'Clear DB and re-fetch everything from both services';
    resyncBtn.addEventListener('click', handleResync);
    el.appendChild(resyncBtn);
  }
}

// ── Charts ────────────────────────────────────────────────────────────────────

let charts = {};

function destroyCharts() {
  for (const c of Object.values(charts)) c.destroy();
  charts = {};
}

function renderCharts(runs) {
  destroyCharts();

  const withPace = runs.filter(r => r.paceMinPerKm != null);
  const withHr   = runs.filter(r => r.avgHr != null);
  const withRei  = runs.filter(r => r.rei != null);

  charts.pace = new Chart(document.getElementById('paceChart'), {
    type: 'line',
    data: {
      labels: withPace.map(r => dateLabel(r.date)),
      datasets: [lineDataset(withPace.map(r => r.paceMinPerKm), '#5b9cf6')],
    },
    options: {
      ...baseOptions({
        reverse: true,
        ticks: { color: '#3e3e3e', callback: v => fmtPace(v) },
      }),
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${fmtPace(ctx.raw)} / km`,
            title: ctx => withPace[ctx[0].dataIndex]?.name || ctx[0].label,
          },
        },
      },
    },
  });

  charts.hr = new Chart(document.getElementById('hrChart'), {
    type: 'line',
    data: {
      labels: withHr.map(r => dateLabel(r.date)),
      datasets: [lineDataset(withHr.map(r => r.avgHr), '#f06e6e')],
    },
    options: {
      ...baseOptions(),
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.raw} bpm`,
            title: ctx => withHr[ctx[0].dataIndex]?.name || ctx[0].label,
          },
        },
      },
    },
  });

  charts.rei = new Chart(document.getElementById('reiChart'), {
    type: 'line',
    data: {
      labels: withRei.map(r => dateLabel(r.date)),
      datasets: [lineDataset(withRei.map(r => r.rei), '#5ecb7e')],
    },
    options: {
      ...baseOptions({
        ticks: { color: '#3e3e3e', callback: v => v.toFixed(2) },
      }),
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` REI ${ctx.raw.toFixed(3)}`,
            title: ctx => withRei[ctx[0].dataIndex]?.name || ctx[0].label,
          },
        },
      },
    },
  });
}

// ── Refresh handler ───────────────────────────────────────────────────────────

async function handleRefresh() {
  const btn = document.getElementById('refresh-btn');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  setStatus('Fetching new runs…');

  try {
    const data = await fetch('/api/refresh', { method: 'POST' }).then(r => r.json());

    if (data.error) {
      setStatus(data.error);
      return;
    }

    if (data.errors?.length) {
      setStatus(data.errors.join(' '));
      renderConnections(data.connected);
    } else if (data.newRuns > 0) {
      setStatus(`Added ${data.newRuns} new run${data.newRuns === 1 ? '' : 's'}.`);
    } else {
      setStatus('Already up to date.');
    }

    const runs = data.runs || [];
    if (runs.length) {
      document.getElementById('charts').hidden = false;
      renderCharts(runs);
    }
  } catch {
    setStatus('Refresh failed. Please try again.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Refresh';
    }
  }
}

async function handleResync() {
  const btn = document.getElementById('resync-btn');
  const refreshBtn = document.getElementById('refresh-btn');
  btn.disabled = true;
  if (refreshBtn) refreshBtn.disabled = true;
  btn.textContent = 'Resyncing…';
  setStatus('Clearing data and re-fetching everything…');

  try {
    const data = await fetch('/api/resync', { method: 'POST' }).then(r => r.json());

    if (data.error) { setStatus(data.error); return; }

    if (data.errors?.length) {
      setStatus(data.errors.join(' '));
    } else {
      setStatus(`Resync complete — ${data.runs.length} runs loaded.`);
    }

    const runs = data.runs || [];
    if (runs.length) {
      document.getElementById('charts').hidden = false;
      document.getElementById('empty-state').hidden = true;
      renderCharts(runs);
    }
  } catch {
    setStatus('Resync failed. Please try again.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Resync all'; }
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function setStatus(msg) {
  document.getElementById('status-bar').textContent = msg;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function init() {
  const params = new URLSearchParams(location.search);
  const authError = params.get('error');

  if (authError) {
    const msgs = {
      strava_denied:  'Strava authorisation was denied.',
      strava_token:   'Strava connection failed — check your client credentials.',
      fitbit_denied:  'Fitbit authorisation was denied.',
      fitbit_token:   'Fitbit connection failed — check your client credentials.',
    };
    setStatus(msgs[authError] || 'Authorisation failed.');
    history.replaceState({}, '', '/');
  }

  const status = await fetch('/api/status').then(r => r.json());
  renderConnections(status);

  // Auto-connect: if neither service is linked and we haven't attempted this
  // session, silently kick off the Strava → Fitbit OAuth chain.
  if (!status.strava && !status.fitbit && !authError) {
    if (!sessionStorage.getItem('authAttempted')) {
      sessionStorage.setItem('authAttempted', '1');
      window.location.href = '/auth/strava?chain=fitbit';
      return;
    }
    document.getElementById('empty-state').hidden = false;
    return;
  }

  setStatus('Loading runs…');

  try {
    const data = await fetch('/api/activities').then(r => r.json());

    if (data.error) { setStatus(data.error); return; }

    if (data.errors?.length) {
      setStatus(data.errors.join(' '));
      renderConnections(data.connected);
    } else {
      setStatus('');
    }

    const runs = data.runs || [];
    if (!runs.length) {
      document.getElementById('empty-state').textContent = 'No runs found.';
      document.getElementById('empty-state').hidden = false;
      return;
    }

    document.getElementById('charts').hidden = false;
    renderCharts(runs);
  } catch {
    setStatus('Failed to load data. Please refresh the page.');
  }
}

init();
