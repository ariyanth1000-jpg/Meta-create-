require('dotenv').config();
const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const path = require('path');
const { extractOTP } = require('./otp');
const dbApi = require('./db');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const IVAS_BASE = 'https://www.ivasms.com/api/v1';
const cache = new NodeCache({ stdTTL: 30 });

const ivas = axios.create({
  baseURL: IVAS_BASE,
  headers: { Authorization: `Bearer ${process.env.IVAS_KEY}`, Accept: 'application/json' },
  timeout: 20000,
});

// 429 auto-retry
ivas.interceptors.response.use(r => r, async (err) => {
  if (err.response?.status === 429) {
    const wait = (err.response.data?.error?.retry_after || 15) * 1000;
    console.warn(`⏳ Rate limited, retry in ${wait / 1000}s`);
    await new Promise(r => setTimeout(r, wait));
    return ivas(err.config);
  }
  throw err;
});

function auth(req, res, next) {
  const pwd = req.headers['x-dashboard-password'] || req.query.pwd;
  if (pwd !== process.env.DASHBOARD_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

const wrap = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    const status = e.response?.status || 500;
    console.error('❌', e.message);
    res.status(status).json(e.response?.data || { success: false, error: e.message });
  }
};

// ---------- NUMBERS ----------
app.get('/api/numbers', auth, wrap(async (req, res) => {
  const key = 'numbers:' + JSON.stringify(req.query);
  if (cache.has(key)) return res.json(cache.get(key));
  const { data } = await ivas.get('/numbers', { params: req.query });
  cache.set(key, data);
  if (data.data?.length) dbApi.saveNumbers(data.data);
  res.json(data);
}));

app.get('/api/numbers/cached', auth, (req, res) => {
  res.json({ success: true, data: dbApi.getCachedNumbers() });
});

// ---------- STATISTICS ----------
app.get('/api/statistics', auth, wrap(async (req, res) => {
  const key = 'stats:' + JSON.stringify(req.query);
  if (cache.has(key)) return res.json(cache.get(key));
  const { data } = await ivas.get('/statistics', { params: req.query });
  cache.set(key, data, 60);
  res.json(data);
}));

app.get('/api/statistics/local', auth, (req, res) => {
  const days = parseInt(req.query.days || '30');
  res.json({ success: true, data: dbApi.getDailyStats(days) });
});

// ---------- MESSAGES ----------
app.get('/api/messages', auth, wrap(async (req, res) => {
  const key = 'msgs:' + JSON.stringify(req.query);
  if (cache.has(key)) return res.json(cache.get(key));
  const { data } = await ivas.get('/messages', { params: req.query });
  cache.set(key, data, 10);
  if (data.data?.length) {
    data.data.forEach(m => {
      const otp = extractOTP(m.message);
      const isNew = dbApi.saveMessage(m, otp);
      if (isNew && otp) console.log(`📩 NEW OTP [${m.number}] → ${otp}`);
    });
  }
  res.json(data);
}));

app.get('/api/messages/local', auth, (req, res) => {
  const { number, q, from, to } = req.query;
  const limit = Math.min(parseInt(req.query.limit || '100'), 500);
  const offset = parseInt(req.query.offset || '0');
  const data = dbApi.getMessages({ number, q, from, to, limit, offset });
  const total = dbApi.countMessages({ number, q });
  res.json({ success: true, data, total, limit, offset });
});

// ---------- OTP ----------
app.get('/api/otp/:number', auth, wrap(async (req, res) => {
  const { number } = req.params;
  const local = dbApi.getLatestOTP(number);
  if (local && (Date.now() - new Date(local.received_at).getTime() < 10 * 60 * 1000)) {
    return res.json({ success: true, source: 'db', ...local });
  }
  const { data } = await ivas.get('/messages', {
    params: {
      number, per_page: 10,
      start_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    },
  });
  for (const m of data.data || []) {
    const otp = extractOTP(m.message);
    if (otp) {
      dbApi.saveMessage(m, otp);
      return res.json({ success: true, source: 'ivas', number, otp, message: m.message, received_at: m.received_at });
    }
  }
  res.json({ success: true, number, otp: null, message: 'No OTP found' });
}));

app.get('/api/otp/latest', auth, (req, res) => {
  res.json({ success: true, data: dbApi.getLatestOTP() || null });
});

// ---------- WEBHOOK ----------
app.post('/api/webhook', (req, res) => {
  const m = req.body || {};
  const otp = extractOTP(m.message || '');
  const isNew = dbApi.saveMessage(m, otp);
  if (isNew) {
    console.log(`🔔 WEBHOOK [${m.number}] ${m.source}${otp ? ' OTP=' + otp : ''}`);
    cache.flushAll();
  }
  res.sendStatus(200);
});

// ---------- POLLING ----------
let pollTimer = null;
let pollRunning = false;

async function pollOnce() {
  if (pollRunning) return;
  pollRunning = true;
  try {
    const { data } = await ivas.get('/messages', {
      params: {
        per_page: 100,
        start_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
      },
    });
    let newCount = 0;
    for (const m of (data.data || [])) {
      const otp = extractOTP(m.message);
      if (dbApi.saveMessage(m, otp)) {
        newCount++;
        if (otp) console.log(`🔄 POLL OTP [${m.number}] → ${otp}`);
      }
    }
    if (newCount) cache.flushAll();
    console.log(`[poll] ${new Date().toISOString()} — ${newCount} new`);
  } catch (e) {
    console.error('[poll error]', e.message);
  } finally {
    pollRunning = false;
  }
}

app.post('/api/polling/start', auth, (req, res) => {
  if (pollTimer) return res.json({ success: true, already: true, running: true });
  const interval = parseInt(process.env.POLL_INTERVAL_MS || '60000');
  pollTimer = setInterval(pollOnce, interval);
  pollOnce();
  res.json({ success: true, running: true, interval_ms: interval });
});

app.post('/api/polling/stop', auth, (req, res) => {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  res.json({ success: true, running: false });
});

app.get('/api/polling/status', auth, (req, res) => {
  res.json({ success: true, running: !!pollTimer });
});

// ---------- SUMMARY ----------
app.get('/api/summary', auth, wrap(async (req, res) => {
  const [numbers, stats, msgs] = await Promise.allSettled([
    ivas.get('/numbers', { params: { per_page: 100 } }),
    ivas.get('/statistics', { params: {} }),
    ivas.get('/messages', { params: { per_page: 20 } }),
  ]);

  const numbersData = numbers.status === 'fulfilled' ? numbers.value.data.data : dbApi.getCachedNumbers();
  const statsData = stats.status === 'fulfilled' ? stats.value.data : null;
  const msgsData = msgs.status === 'fulfilled' ? msgs.value.data.data : [];

  if (numbersData?.length && numbers.status === 'fulfilled') dbApi.saveNumbers(numbersData);
  msgsData.forEach(m => dbApi.saveMessage(m, extractOTP(m.message)));

  res.json({
    success: true,
    numbers: numbersData,
    statistics: statsData,
    recent_messages: msgsData,
    otp_stats: dbApi.getOtpStats(),
    local_daily: dbApi.getDailyStats(14),
    polling: !!pollTimer,
  });
}));

// ---------- RATE INFO ----------
app.get('/api/rate-info', auth, wrap(async (req, res) => {
  const r = await ivas.get('/numbers', { params: { per_page: 1 } });
  res.json({
    success: true,
    limit: r.headers['x-ratelimit-limit'],
    remaining: r.headers['x-ratelimit-remaining'],
  });
}));

// ---------- HEALTH ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), polling: !!pollTimer });
});

// ---------- AUTO-START POLLING on boot (optional) ----------
if (process.env.AUTO_POLL === 'true') {
  const interval = parseInt(process.env.POLL_INTERVAL_MS || '60000');
  pollTimer = setInterval(pollOnce, interval);
  pollOnce();
  console.log('▶ Polling auto-started');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Server running on port ${PORT}`));
