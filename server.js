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

// 429 Rate Limit Auto-Retry 
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

// 1. iVAS থেকে লাইভ নাম্বার আনা (ব্যান্ডউইথ বাঁচাতে ক্যাশে রাখা হয়)
app.get('/api/numbers', wrap(async (req, res) => {
  const key = 'numbers:' + JSON.stringify(req.query);
  if (cache.has(key)) return res.json(cache.get(key));
  const { data } = await ivas.get('/numbers', { params: req.query });
  cache.set(key, data);
  if (data.data?.length) dbApi.saveNumbers(data.data);
  res.json(data);
}));

// 2. ডাটাবেস থেকে নাম্বার আনা (ইউজাররা এটা দেখবে, যাতে API লিমিট না শেষ হয়)
app.get('/api/numbers/local', (req, res) => {
  const data = dbApi.getCachedNumbers();
  res.json({ success: true, data });
});

// 3. ডাটাবেস থেকে OTP লিস্ট আনা (লাইভ আপডেট)
app.get('/api/messages/local', (req, res) => {
  const { number, q, from, to } = req.query;
  const limit = Math.min(parseInt(req.query.limit || '50'), 500);
  const offset = parseInt(req.query.offset || '0');
  const data = dbApi.getMessages({ number, q, from, to, limit, offset });
  const total = dbApi.countMessages({ number, q });
  res.json({ success: true, data, total, limit, offset });
});

// 4. Get Number (নাম্বার ডিলিট করা)
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

// 5. API Limit দেখার জন্য
app.get('/api/rate-info', wrap(async (req, res) => {
  const r = await ivas.get('/numbers', { params: { per_page: 1 } });
  res.json({
    success: true,
    limit: r.headers['x-ratelimit-limit'],
    remaining: r.headers['x-ratelimit-remaining'],
  });
}));

// ==========================================
// Polling System (ব্যাকগ্রাউন্ডে OTP চেক করবে)
// ==========================================
let pollTimer = null;
let pollRunning = false;

async function pollOnce() {
  if (pollRunning) return;
  pollRunning = true;
  try {
    // ১. নতুন নাম্বার সিঙ্ক করা
    const numRes = await ivas.get('/numbers', { params: { per_page: 100 } });
    if (numRes.data.data?.length) {
      dbApi.saveNumbers(numRes.data.data);
    }

    // ২. নতুন মেসেজ সিঙ্ক করা
    const msgRes = await ivas.get('/messages', {
      params: {
        per_page: 100,
        start_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
      },
    });
    
    let newCount = 0;
    for (const m of (msgRes.data.data || [])) {
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
  pollOnce(); // সার্ভার চালু হওয়ার সাথে সাথেই একবার চেক করবে
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Tamim Number Panel running on port ${PORT}`));
