require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';

app.use(express.json());
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

// ── MongoDB ───────────────────────────────────────────────────────────────────

const mongo = new MongoClient(MONGODB_URI);
let db;

async function connectDB() {
  await mongo.connect();
  db = mongo.db('running');
  const col = db.collection('runs');
  // sparse so multiple nulls don't violate uniqueness
  await col.createIndex({ stravaId: 1 },   { unique: true, sparse: true });
  await col.createIndex({ fitbitLogId: 1 }, { unique: true, sparse: true });
  await col.createIndex({ date: 1 });
  console.log('MongoDB connected');
}

async function getAllRuns() {
  return db.collection('runs')
    .find({})
    .sort({ date: 1 })
    .project({ _id: 0 })
    .toArray();
}

async function getLastRun() {
  return db.collection('runs').findOne(
    {},
    { sort: { date: -1 }, projection: { _id: 0 } }
  );
}

// Returns the number of newly inserted (upserted) runs.
async function saveRuns(runs) {
  if (!runs.length) return 0;

  // Purge any Fitbit-only runs — only matched runs are kept.
  await db.collection('runs').deleteMany({ stravaId: { $exists: false } });

  const ops = runs.map(run => ({
    updateOne: {
      filter: run.stravaId != null
        ? { stravaId: run.stravaId }
        : { fitbitLogId: run.fitbitLogId },
      update: { $set: run },
      upsert: true,
    },
  }));
  const result = await db.collection('runs').bulkWrite(ops, { ordered: false });
  return result.upsertedCount;
}

// ── Strava OAuth ──────────────────────────────────────────────────────────────

app.get('/auth/strava', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    response_type: 'code',
    redirect_uri: `${BASE_URL}/auth/strava/callback`,
    approval_prompt: 'auto',
    scope: 'read,activity:read_all',
  });
  // state=fitbit signals the callback to chain into Fitbit auth
  if (req.query.chain === 'fitbit') params.set('state', 'fitbit');
  res.redirect(`https://www.strava.com/oauth/authorize?${params}`);
});

app.get('/auth/strava/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error || !code) return res.redirect('/?error=strava_denied');

  try {
    const { data } = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    });
    req.session.stravaToken = data.access_token;
    req.session.stravaRefresh = data.refresh_token;
    req.session.stravaExpiry = data.expires_at * 1000;

    if (state === 'fitbit' && !req.session.fitbitToken) {
      return res.redirect('/auth/fitbit');
    }
    res.redirect('/');
  } catch (err) {
    console.error('Strava token error:', err.response?.data || err.message);
    res.redirect('/?error=strava_token');
  }
});

// ── Fitbit OAuth ──────────────────────────────────────────────────────────────

app.get('/auth/fitbit', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.FITBIT_CLIENT_ID,
    response_type: 'code',
    redirect_uri: `${BASE_URL}/auth/fitbit/callback`,
    scope: 'activity heartrate',
    expires_in: '604800',
  });
  res.redirect(`https://www.fitbit.com/oauth2/authorize?${params}`);
});

app.get('/auth/fitbit/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/?error=fitbit_denied');

  const credentials = Buffer.from(
    `${process.env.FITBIT_CLIENT_ID}:${process.env.FITBIT_CLIENT_SECRET}`
  ).toString('base64');

  try {
    const { data } = await axios.post(
      'https://api.fitbit.com/oauth2/token',
      new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${BASE_URL}/auth/fitbit/callback`,
      }),
      {
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
    req.session.fitbitToken = data.access_token;
    req.session.fitbitRefresh = data.refresh_token;
    req.session.fitbitExpiry = Date.now() + data.expires_in * 1000;
    res.redirect('/');
  } catch (err) {
    console.error('Fitbit token error:', err.response?.data || err.message);
    res.redirect('/?error=fitbit_token');
  }
});

// ── Token refresh helpers ─────────────────────────────────────────────────────

async function refreshStravaToken(session) {
  if (!session.stravaExpiry || Date.now() < session.stravaExpiry - 60_000) return;
  try {
    const { data } = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: session.stravaRefresh,
      grant_type: 'refresh_token',
    });
    session.stravaToken = data.access_token;
    session.stravaRefresh = data.refresh_token;
    session.stravaExpiry = data.expires_at * 1000;
  } catch (err) {
    console.error('Strava refresh error:', err.message);
    session.stravaToken = null;
  }
}

async function refreshFitbitToken(session) {
  if (!session.fitbitExpiry || Date.now() < session.fitbitExpiry - 60_000) return;
  const credentials = Buffer.from(
    `${process.env.FITBIT_CLIENT_ID}:${process.env.FITBIT_CLIENT_SECRET}`
  ).toString('base64');
  try {
    const { data } = await axios.post(
      'https://api.fitbit.com/oauth2/token',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: session.fitbitRefresh,
      }),
      {
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
    session.fitbitToken = data.access_token;
    session.fitbitRefresh = data.refresh_token;
    session.fitbitExpiry = Date.now() + data.expires_in * 1000;
  } catch (err) {
    console.error('Fitbit refresh error:', err.message);
    session.fitbitToken = null;
  }
}

// ── Fetch Strava runs ─────────────────────────────────────────────────────────

const START_OF_2026 = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);

async function fetchStravaRuns(token, after = START_OF_2026) {
  const runs = [];
  let page = 1;
  while (true) {
    const { data } = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
      headers: { Authorization: `Bearer ${token}` },
      params: { per_page: 100, page, after },
    });
    if (!data.length) break;
    const pageRuns = data.filter(a => a.type === 'Run' || a.sport_type === 'Run');
    runs.push(...pageRuns);
    if (data.length < 100) break;
    page++;
  }
  return runs;
}

// ── Fetch Fitbit runs ─────────────────────────────────────────────────────────

async function fetchFitbitRuns(token, afterDateStr = '2025-12-31') {
  const runs = [];
  let offset = 0;
  while (true) {
    const { data } = await axios.get(
      'https://api.fitbit.com/1/user/-/activities/list.json',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Accept-Language': 'en_GB', // metric units
        },
        params: { afterDate: afterDateStr, sort: 'asc', limit: 100, offset },
      }
    );
    const activities = (data.activities || []).filter(a =>
      a.activityTypeId === 90009 ||
      (a.activityName || '').toLowerCase().includes('run')
    );
    runs.push(...activities);
    if (!data.pagination?.next) break;
    offset += 100;
    if (offset > 900) break;
  }
  return runs;
}

// ── Merge & correlate ─────────────────────────────────────────────────────────

// Strava manual activities are entered in local time but stored as UTC.
// Fitbit returns times with the correct Dubai offset (+04:00).
// Subtract the Dubai offset from manual Strava timestamps before comparing.
const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000; // UTC+4, no DST
const DEDUP_WINDOW_MS = 5 * 60 * 60 * 1000; // 5-hour dedup window

function dubaiDateStr(utcMs) {
  return new Date(utcMs + DUBAI_OFFSET_MS).toISOString().slice(0, 10);
}

function stravaUtcMs(activity) {
  const raw = new Date(activity.start_date).getTime();
  return activity.manual ? raw - DUBAI_OFFSET_MS : raw;
}

// Fitbit's startTime may or may not include a timezone offset.
// If it has one (e.g. "+04:00" or "Z") Date() handles it correctly.
// If not, the value is local Dubai time — we subtract the offset to get UTC.
function fitbitUtcMs(startTime) {
  if (/[Zz]$/.test(startTime) || /[+-]\d{2}:\d{2}$/.test(startTime)) {
    return new Date(startTime).getTime();
  }
  return new Date(startTime).getTime() - DUBAI_OFFSET_MS;
}

function toMeters(fitbitActivity) {
  const dist = fitbitActivity.distance || 0;
  const unit = (fitbitActivity.distanceUnit || '').toLowerCase();
  if (unit === 'mile' || unit === 'miles') return dist * 1609.344;
  return dist * 1000;
}

function mergeRuns(stravaRuns, fitbitRuns) {
  const usedFitbit = new Set();
  const result = [];

  for (const strava of stravaRuns) {
    const stravaTime = stravaUtcMs(strava);

    let fitbitMatch = null;
    for (let i = 0; i < fitbitRuns.length; i++) {
      if (usedFitbit.has(i)) continue;
      const fb = fitbitRuns[i];
      const fbTime = fitbitUtcMs(fb.startTime);
      if (Math.abs(stravaTime - fbTime) <= DEDUP_WINDOW_MS &&
          dubaiDateStr(stravaTime) === dubaiDateStr(fbTime)) {
        fitbitMatch = fb;
        usedFitbit.add(i);
        break;
      }
    }

    const speedMperMin = strava.average_speed
      ? strava.average_speed * 60
      : strava.moving_time > 0
        ? strava.distance / (strava.moving_time / 60)
        : null;

    const paceMinPerKm =
      strava.distance > 0 && strava.moving_time > 0
        ? strava.moving_time / 60 / (strava.distance / 1000)
        : null;

    const avgHr = fitbitMatch?.averageHeartRate || strava.average_heartrate || null;
    const rei = speedMperMin && avgHr ? speedMperMin / avgHr : null;

    result.push({
      stravaId: strava.id,
      ...(fitbitMatch?.logId != null && { fitbitLogId: fitbitMatch.logId }),
      date: strava.start_date,
      source: fitbitMatch ? 'both' : 'strava',
      name: strava.name,
      distanceKm: strava.distance / 1000,
      durationMin: strava.moving_time / 60,
      speedMperMin,
      paceMinPerKm,
      avgHr,
      rei,
    });
  }

  result.sort((a, b) => new Date(a.date) - new Date(b.date));
  return result;
}

// ── Shared fetch + save logic ─────────────────────────────────────────────────

async function fetchAndSave(session, stravaAfter, fitbitAfterDate) {
  await Promise.all([
    refreshStravaToken(session),
    refreshFitbitToken(session),
  ]);

  const { stravaToken, fitbitToken } = session;
  let stravaRuns = [];
  let fitbitRuns = [];
  const errors = [];

  if (stravaToken) {
    try {
      stravaRuns = await fetchStravaRuns(stravaToken, stravaAfter);
    } catch (err) {
      if (err.response?.status === 401) {
        session.stravaToken = null;
        errors.push('Strava session expired — please reconnect.');
      } else {
        errors.push(`Strava fetch failed: ${err.message}`);
      }
    }
  }

  if (fitbitToken) {
    try {
      fitbitRuns = await fetchFitbitRuns(fitbitToken, fitbitAfterDate);
    } catch (err) {
      if (err.response?.status === 401) {
        session.fitbitToken = null;
        errors.push('Fitbit session expired — please reconnect.');
      } else {
        errors.push(`Fitbit fetch failed: ${err.message}`);
      }
    }
  }

  console.log(`Fetched: ${stravaRuns.length} Strava runs, ${fitbitRuns.length} Fitbit runs`);
  const runs = mergeRuns(stravaRuns, fitbitRuns);
  const matched = runs.filter(r => r.source === 'both').length;
  console.log(`Merged: ${runs.length} total (${matched} matched, ${runs.filter(r=>r.source==='strava').length} Strava-only, ${runs.filter(r=>r.source==='fitbit').length} Fitbit-only)`);
  if (fitbitRuns.length && !matched) {
    const sample = fitbitRuns[0];
    const sampleStrava = stravaRuns[0];
    console.log(`  Sample Fitbit startTime: ${sample.startTime} → UTC ms: ${fitbitUtcMs(sample.startTime)}`);
    if (sampleStrava) console.log(`  Sample Strava start_date: ${sampleStrava.start_date} → UTC ms: ${stravaUtcMs(sampleStrava)}`);
  }
  const newCount = await saveRuns(runs);
  return { runs, newCount, errors };
}

// ── API routes ────────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json({
    strava: !!req.session.stravaToken,
    fitbit: !!req.session.fitbitToken,
  });
});

// Returns runs from DB. If DB is empty, does a full initial sync first.
app.get('/api/activities', async (req, res) => {
  try {
    const existing = await getAllRuns();
    if (existing.length > 0) {
      return res.json({
        runs: existing,
        connected: { strava: !!req.session.stravaToken, fitbit: !!req.session.fitbitToken },
        errors: [],
      });
    }

    if (!req.session.stravaToken && !req.session.fitbitToken) {
      return res.status(401).json({ error: 'Not connected to any service.' });
    }

    const { runs, errors } = await fetchAndSave(
      req.session,
      START_OF_2026,
      '2025-12-31'
    );

    res.json({
      runs: await getAllRuns(), // read back from DB (sorted, _id stripped)
      connected: { strava: !!req.session.stravaToken, fitbit: !!req.session.fitbitToken },
      errors,
    });
  } catch (err) {
    console.error('/api/activities error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Fetches runs since the last DB entry and upserts them.
app.post('/api/refresh', async (req, res) => {
  if (!req.session.stravaToken && !req.session.fitbitToken) {
    return res.status(401).json({ error: 'Not connected to any service.' });
  }

  try {
    const lastRun = await getLastRun();

    let stravaAfter = START_OF_2026;
    let fitbitAfterDate = '2025-12-31';

    if (lastRun) {
      const lastDate = new Date(lastRun.date);
      // Subtract 1s so Strava includes the last run → gets deduped by stravaId
      stravaAfter = Math.floor(lastDate.getTime() / 1000) - 1;
      fitbitAfterDate = lastDate.toISOString().split('T')[0];
    }

    const { newCount, errors } = await fetchAndSave(
      req.session,
      stravaAfter,
      fitbitAfterDate
    );

    res.json({
      runs: await getAllRuns(),
      newRuns: newCount,
      connected: { strava: !!req.session.stravaToken, fitbit: !!req.session.fitbitToken },
      errors,
    });
  } catch (err) {
    console.error('/api/refresh error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Wipes the DB and does a full re-fetch from both services.
app.post('/api/resync', async (req, res) => {
  if (!req.session.stravaToken && !req.session.fitbitToken) {
    return res.status(401).json({ error: 'Not connected to any service.' });
  }

  try {
    await db.collection('runs').deleteMany({});
    console.log('DB cleared, starting full resync…');

    const { errors } = await fetchAndSave(req.session, START_OF_2026, '2025-12-31');

    res.json({
      runs: await getAllRuns(),
      connected: { strava: !!req.session.stravaToken, fitbit: !!req.session.fitbitToken },
      errors,
    });
  } catch (err) {
    console.error('/api/resync error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/auth/logout/strava', (req, res) => {
  req.session.stravaToken = null;
  req.session.stravaRefresh = null;
  req.session.stravaExpiry = null;
  res.redirect('/');
});

app.get('/auth/logout/fitbit', (req, res) => {
  req.session.fitbitToken = null;
  req.session.fitbitRefresh = null;
  req.session.fitbitExpiry = null;
  res.redirect('/');
});

// ── Start ─────────────────────────────────────────────────────────────────────

connectDB()
  .then(() => app.listen(PORT, () => console.log(`Running dashboard → http://localhost:${PORT}`)))
  .catch(err => { console.error('Failed to connect to MongoDB:', err.message); process.exit(1); });
