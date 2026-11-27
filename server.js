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

// রেঞ্জ লোড (যদি ডাটাবেস খালি থাকে, তবে iVAS থেকে সাথে সাথে নিয়ে আসবে)
app.get('/api/ranges', async (req, res) => {
  let ranges = dbApi.getUniqueRanges();
  if (ranges.length === 0) {
    await pollOnce(); // ফোর্স আপডেট
    ranges = dbApi.getUniqueRanges();
  }
  res.json({ success: true, data: ranges });
});

// নাম্বার নেওয়া
app.post('/api/numbers/get', (req, res) => {
  try {
    const { range } = req.body;
    if (!range) return res.json({ success: false, message: 'Please select a range' });

    const numData = dbApi.getNumberByRange(range);
    if (!numData) {
      return res.json({ success: false, message: 'No numbers left in this range' });
    }
    
    dbApi.deleteNumber(numData.number);
    res.json({ success: true, number: numData.number });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// OTP লিস্ট (কারেন্ট নাম্বার দিয়ে ফিল্টার হবে)
app.get('/api/messages/local', (req, res) => {
  const { number } = req.query;
  const limit = Math.min(parseInt(req.query.limit || '50'), 500);
  const offset = parseInt(req.query.offset || '0');
  
  const data = dbApi.getMessages({ number, limit, offset });
  const total = dbApi.countMessages(number);
  
  res.json({ success: true, data, total, limit, offset });
});


// Polling System
let pollTimer = null;
let pollRunning = false;

async function pollOnce() {
  if (pollRunning) return;
  pollRunning = true;
  try {
    const numRes = await ivas.get('/numbers', { params: { per_page: 100 } });
    if (numRes.data.data?.length) {
      dbApi.saveNumbers(numRes.data.data);
    }

    const msgRes = await ivas.get('/messages', {
      params: {
        per_page: 100,
        start_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
      },
    });
    
    let newCount = 0;
    for (const m of (msgRes.data.data || [])) {
      const otp = extractOTP(m.message);
      if (dbApi.saveMessage(m, otp)) newCount++;
    }
  } catch (e) {
    console.error('[poll error]', e.message);
  } finally {
    pollRunning = false;
  }
}

pollOnce(); 

if (process.env.AUTO_POLL === 'true') {
  const interval = parseInt(process.env.POLL_INTERVAL_MS || '60000');
  pollTimer = setInterval(pollOnce, interval);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Tamim Panel running on port ${PORT}`));
