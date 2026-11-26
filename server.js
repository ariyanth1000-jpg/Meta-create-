const express = require('express');
const { chromium } = require('playwright');
const axios = require('axios');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PASSWORD = "Tamim100";
const SHEET_URL = "https://script.google.com/macros/s/AKfycbxAhK9zUcjwSNGe4ykaz1r8UZlzVecBP9jblSD13ZkEmh2nzPLTucNqEsNmFx9iwOdmPg/exec";

// *** এখানে আপনার প্রক্সি দিন (Render-এ ছাড়া একাউন্ট ব্লক হবে) ***
// উদাহরণ: const PROXY_SERVER = "http://username:password@proxy-ip:port";
const PROXY_SERVER = null; 

let liveEmails = []; // মেমোরিতে ইমেইল রাখার জন্য

async function createAccount(workerId) {
    console.log(`[Worker ${workerId}] Starting...`);
    let browser;
    try {
        // Render-এ Chromium চালানোর জন্য --no-sandbox যুক্ত করা হয়েছে
        browser = await chromium.launch({ 
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const contextOptions = {
            userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36'
        };

        if (PROXY_SERVER) {
            contextOptions.proxy = { server: PROXY_SERVER };
        }

        const context = await browser.newContext(contextOptions);
        const page = await context.newPage();
        
        let email = `bot${Math.floor(Math.random()*999999)}@mailmomy.com`; 
        
        console.log(`[Worker ${workerId}] Going to Meta...`);
        await page.goto('https://auth.meta.com/', { waitUntil: 'domcontentloaded' });

        const useEmailBtn = await page.locator('text=Use mobile number or email address').first();
        if (await useEmailBtn.isVisible()) { await useEmailBtn.click(); await page.waitForTimeout(1000); }

        const emailInput = page.locator('input[type="email"], input[name="email"]').first();
        await emailInput.waitFor({ state: 'visible', timeout: 10000 });
        await emailInput.fill(email);
        
        const continueBtn = page.locator('text=Continue').last();
        await continueBtn.click();
        await page.waitForTimeout(3000);

        const nameInputs = page.locator('input[type="text"]');
        if (await nameInputs.count() >= 2) {
            await nameInputs.nth(0).fill("Sumaiya");
            await nameInputs.nth(1).fill("Akter");
            await page.locator('text=Next').last().click();
            await page.waitForTimeout(2000);
        }

        const pwInput = page.locator('input[type="password"]');
        if (await pwInput.isVisible()) {
            await pwInput.fill(PASSWORD);
            await page.locator('text=Continue').last().click();
            await page.waitForTimeout(3000);
        }

        const pageContent = await page.content();
        if (pageContent.includes('confirmation code') || pageContent.includes('we sent a code') || pageContent.includes('confirmation')) {
            console.log(`[Worker ${workerId}] ✅ Account Created: ${email}`);
            
            // শিটে পাঠানো
            await axios.post(SHEET_URL, {
                emailMobile: email,
                password: PASSWORD,
                provider: 'meta_ai',
                museVerified: 'Meta Created'
            }).catch(e => console.log('Sheet Error'));

            // ফ্রন্টএন্ডে লাইভ দেখানোর জন্য অ্যারেতে রাখা
            liveEmails.push(email);
            return { success: true, email };
        } else {
            console.log(`[Worker ${workerId}] ❌ Failed or Blocked.`);
            return { success: false };
        }

    } catch (err) {
        console.log(`[Worker ${workerId}] Error:`, err.message);
        return { success: false };
    } finally {
        if (browser) await browser.close();
    }
}

// ইমেইল লিস্ট আনার API (Polling এর জন্য)
app.get('/api/emails', (req, res) => {
    res.json({ emails: liveEmails });
});

// রিসেট API
app.post('/api/reset', (req, res) => {
    liveEmails = [];
    res.json({ message: 'Cleared' });
});

app.post('/api/start', async (req, res) => {
    const count = parseInt(req.body.count) || 1;
    console.log(`\n🚀 Request received to create ${count} accounts...`);
    
    res.json({ message: `Started ${count} workers in background.` });

    for (let i = 1; i <= count; i++) {
        await createAccount(i);
        await new Promise(r => setTimeout(r, 2000));
    }
});

// Render ডিফল্টভাবে PORT এনভায়রনমেন্ট ভেরিয়েবল ব্যবহার করে
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🌐 Server running on port ${PORT}`);
});
