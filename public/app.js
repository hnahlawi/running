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

// Returns the ISO date string (YYYY-MM-DD) of the Monday that starts the week
// containing the given ISO date string.
function weekMonday(iso) {
  const d = new Date(iso);
  // getDay(): 0=Sun, 1=Mon…6=Sat — shift so Mon=0
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return d.toISOString().slice(0, 10);
}

// Aggregate an array of runs into weekly buckets (Mon–Sun).
// Returns an array of week objects sorted ascending by Monday date.
function groupByWeek(runs) {
  const buckets = new Map();

  for (const r of runs) {
    const mon = weekMonday(r.date);
    if (!buckets.has(mon)) {
      buckets.set(mon, { mon, runs: [] });
    }
    buckets.get(mon).runs.push(r);
  }

  const weeks = [...buckets.values()].sort((a, b) => (a.mon < b.mon ? -1 : 1));

  return weeks.map(w => {
    const { mon, runs } = w;

    // Pace: distance-weighted (totalDuration / totalDistance)
    const paceRuns = runs.filter(r => r.distanceKm > 0 && r.durationMin > 0);
    const totalDist = paceRuns.reduce((s, r) => s + r.distanceKm, 0);
    const totalDur  = paceRuns.reduce((s, r) => s + r.durationMin, 0);
    const paceMinPerKm = totalDist > 0 ? totalDur / totalDist : null;

    // HR: simple mean
    const hrRuns = runs.filter(r => r.avgHr != null);
    const avgHr = hrRuns.length ? hrRuns.reduce((s, r) => s + r.avgHr, 0) / hrRuns.length : null;

    // REI: simple mean
    const reiRuns = runs.filter(r => r.rei != null);
    const rei = reiRuns.length ? reiRuns.reduce((s, r) => s + r.rei, 0) / reiRuns.length : null;

    // Week label: "Mon M/D/YY"
    const monDate = new Date(mon + 'T00:00:00');
    const sunDate = new Date(monDate);
    sunDate.setDate(monDate.getDate() + 6);
    const fmt = d => `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
    const label = fmt(monDate);
    const rangeLabel = `${fmt(monDate)} – ${fmt(sunDate)}`;

    const totalKm = runs.reduce((s, r) => s + (r.distanceKm || 0), 0);

    return { mon, label, rangeLabel, paceMinPerKm, avgHr, rei, totalKm, runCount: runs.length };
  });
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

// ── Week filter ───────────────────────────────────────────────────────────────

let allRuns = [];
let weeksFilter = 0; // 0 = show all

function filterByWeeks(runs, weeks) {
  if (!weeks) return runs;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - weeks * 7);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return runs.filter(r => r.date >= cutoffStr);
}

function applyFilterAndRender() {
  renderCharts(filterByWeeks(allRuns, weeksFilter));
}

function initWeekFilter() {
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      weeksFilter = Number(btn.dataset.weeks);
      applyFilterAndRender();
    });
  });
}

// ── Charts ────────────────────────────────────────────────────────────────────

let charts = {};

function destroyCharts() {
  for (const c of Object.values(charts)) c.destroy();
  charts = {};
}

function renderCharts(runs) {
  destroyCharts();

  const weeks = groupByWeek(runs);

  const withPace    = weeks.filter(w => w.paceMinPerKm != null);
  const withHr      = weeks.filter(w => w.avgHr != null);
  const withRei     = weeks.filter(w => w.rei != null);
  const withMileage = weeks.filter(w => w.totalKm > 0);

  charts.mileage = new Chart(document.getElementById('mileageChart'), {
    type: 'bar',
    data: {
      labels: withMileage.map(w => w.label),
      datasets: [{
        data: withMileage.map(w => parseFloat(w.totalKm.toFixed(2))),
        backgroundColor: '#f5a623',
        borderRadius: 3,
        borderSkipped: false,
      }],
    },
    options: {
      ...baseOptions({ beginAtZero: true }),
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.raw.toFixed(1)} km`,
            title: ctx => `Week of ${withMileage[ctx[0].dataIndex].rangeLabel}`,
          },
        },
      },
    },
  });

  charts.pace = new Chart(document.getElementById('paceChart'), {
    type: 'line',
    data: {
      labels: withPace.map(w => w.label),
      datasets: [lineDataset(withPace.map(w => w.paceMinPerKm), '#5b9cf6')],
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
            title: ctx => `Week of ${withPace[ctx[0].dataIndex].rangeLabel}`,
          },
        },
      },
    },
  });

  charts.hr = new Chart(document.getElementById('hrChart'), {
    type: 'line',
    data: {
      labels: withHr.map(w => w.label),
      datasets: [lineDataset(withHr.map(w => w.avgHr), '#f06e6e')],
    },
    options: {
      ...baseOptions(),
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${Math.round(ctx.raw)} bpm avg`,
            title: ctx => `Week of ${withHr[ctx[0].dataIndex].rangeLabel}`,
          },
        },
      },
    },
  });

  charts.rei = new Chart(document.getElementById('reiChart'), {
    type: 'line',
    data: {
      labels: withRei.map(w => w.label),
      datasets: [lineDataset(withRei.map(w => w.rei), '#5ecb7e')],
    },
    options: {
      ...baseOptions({
        ticks: { color: '#3e3e3e', callback: v => v.toFixed(2) },
      }),
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` REI ${ctx.raw.toFixed(3)} avg`,
            title: ctx => `Week of ${withRei[ctx[0].dataIndex].rangeLabel}`,
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
      allRuns = runs;
      document.getElementById('charts').hidden = false;
      applyFilterAndRender();
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
      allRuns = runs;
      document.getElementById('charts').hidden = false;
      document.getElementById('empty-state').hidden = true;
      applyFilterAndRender();
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

    allRuns = runs;
    document.getElementById('charts').hidden = false;
    applyFilterAndRender();
  } catch {
    setStatus('Failed to load data. Please refresh the page.');
  }
}

init();
initWeekFilter();
