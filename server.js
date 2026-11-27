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

ivas.interceptors.response.use(r => r, async (err) => {
  if (err.response?.status === 429) {
    const wait = (err.response.data?.error?.retry_after || 15) * 1000;
    await new Promise(r => setTimeout(r, wait));
    return ivas(err.config);
  }
  throw err;
});

const wrap = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    const status = e.response?.status || 500;
    res.status(status).json(e.response?.data || { success: false, error: e.message });
  }
};

// API Routes (কোনো Auth নেই)

app.get('/api/numbers', wrap(async (req, res) => {
  const key = 'numbers:' + JSON.stringify(req.query);
  if (cache.has(key)) return res.json(cache.get(key));
  const { data } = await ivas.get('/numbers', { params: req.query });
  cache.set(key, data);
  if (data.data?.length) dbApi.saveNumbers(data.data);
  res.json(data);
}));

app.get('/api/messages/local', (req, res) => {
  const { number, q, from, to } = req.query;
  const limit = Math.min(parseInt(req.query.limit || '50'), 500);
  const offset = parseInt(req.query.offset || '0');
  const data = dbApi.getMessages({ number, q, from, to, limit, offset });
  const total = dbApi.countMessages({ number, q });
  res.json({ success: true, data, total, limit, offset });
});

app.post('/api/numbers/get', (req, res) => {
  try {
    const numbers = dbApi.getCachedNumbers();
    if (numbers.length === 0) {
      return res.json({ success: false, message: 'No numbers left to get' });
    }
    const numberToDelete = numbers[0].number;
    dbApi.deleteNumber(numberToDelete);
    res.json({ success: true, number: numberToDelete });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/rate-info', wrap(async (req, res) => {
  const r = await ivas.get('/numbers', { params: { per_page: 1 } });
  res.json({
    success: true,
    limit: r.headers['x-ratelimit-limit'],
    remaining: r.headers['x-ratelimit-remaining'],
  });
}));

// Polling System (AUTO POLL)
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
      }
    }
    if (newCount) cache.flushAll();
  } catch (e) {
    console.error('[poll error]', e.message);
  } finally {
    pollRunning = false;
  }
}

if (process.env.AUTO_POLL === 'true') {
  const interval = parseInt(process.env.POLL_INTERVAL_MS || '60000');
  pollTimer = setInterval(pollOnce, interval);
  pollOnce();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Server running on port ${PORT}`));
