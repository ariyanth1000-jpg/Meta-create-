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

let liveEmails = [];
let liveLogs = []; // নতুন: লাইভ লগ রাখার জন্য
let isRunning = false;

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    const logMsg = `[${time}] ${msg}`;
    console.log(logMsg); // Render সার্ভার লগে দেখাবে
    liveLogs.push(logMsg); // ওয়েবসাইটে দেখাবে
    if (liveLogs.length > 50) liveLogs.shift(); // সর্বোচ্চ ৫০টি লগ রাখবে
}

async function getEmailFromApi() {
    try {
        addLog("Fetching email from API...");
        const resp = await axios.get('https://mailmomy.com/api/domains/active', { timeout: 8000 });
        let domains = [];
        if (resp.data) {
            if (Array.isArray(resp.data)) domains = resp.data;
            else if (resp.data.domains) domains = resp.data.domains;
            else if (resp.data.data) domains = resp.data.data;
        }
        if (domains.length > 0) {
            const d = domains[Math.floor(Math.random() * domains.length)];
            let domainStr = typeof d === 'string' ? d : (d.domain || d.name);
            if (domainStr) {
                const email = `${Math.random().toString(36).substring(2, 10)}@${domainStr}`;
                addLog(`Email generated: ${email}`);
                return email;
            }
        }
    } catch (e) { 
        addLog(`API Error: ${e.message}`); 
    }
    addLog("API Failed, using fallback email.");
    return `bot${Math.floor(Math.random()*999999)}@mailmomy.com`;
}

async function createAccount(workerId) {
    addLog(`[Worker ${workerId}] Starting browser...`);
    let browser;
    try {
        browser = await chromium.launch({ 
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process']
        });

        const contextOptions = {
            userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
            viewport: { width: 412, height: 915 }
        };

        const context = await browser.newContext(contextOptions);
        const page = await context.newPage();
        
        let email = await getEmailFromApi();
        
        addLog(`[Worker ${workerId}] Going to Meta...`);
        await page.goto('https://auth.meta.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);

        addLog(`[Worker ${workerId}] Clicking 'Use mobile or email'...`);
        const useEmailBtn = await page.locator('text=Use mobile number or email address').first();
        if (await useEmailBtn.isVisible().catch(() => false)) { 
            await useEmailBtn.click(); 
            await page.waitForTimeout(1500); 
        }

        addLog(`[Worker ${workerId}] Filling Email...`);
        const emailInput = page.locator('input[type="email"], input[name="email"], input[type="text"]').first();
        await emailInput.waitFor({ state: 'visible', timeout: 15000 });
        await emailInput.fill(email);
        await page.waitForTimeout(500);
        
        addLog(`[Worker ${workerId}] Clicking Continue...`);
        const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Next")').last();
        await continueBtn.click();
        await page.waitForTimeout(4000);

        // চেক করা মেটা ব্লক করেছে কিনা
        let content = await page.content();
        if (content.includes('Access Denied') || content.includes('Something went wrong')) {
            addLog(`[Worker ${workerId}] ❌ Blocked by Meta (Access Denied/Error).`);
            return { success: false };
        }

        const nameInputs = page.locator('input[type="text"]');
        if (await nameInputs.count() >= 2) {
            addLog(`[Worker ${workerId}] Filling Name...`);
            await nameInputs.nth(0).fill("Sumaiya");
            await nameInputs.nth(1).fill("Akter");
            await page.locator('button:has-text("Next"), button:has-text("Continue")').last().click();
            await page.waitForTimeout(3000);
        }

        const pwInput = page.locator('input[type="password"]');
        if (await pwInput.isVisible().catch(() => false)) {
            addLog(`[Worker ${workerId}] Filling Password...`);
            await pwInput.fill(PASSWORD);
            await page.locator('button:has-text("Continue"), button:has-text("Next")').last().click();
            await page.waitForTimeout(4000);
        }

        content = await page.content();
        if (content.includes('confirmation code') || content.includes('we sent a code') || content.includes('confirm your account')) {
            addLog(`[Worker ${workerId}] ✅ Account Created: ${email}`);
            
            await axios.post(SHEET_URL, {
                emailMobile: email,
                password: PASSWORD,
                provider: 'meta_ai',
                museVerified: 'Meta Created'
            }).catch(e => addLog('Sheet Error'));

            liveEmails.push(email);
            return { success: true, email };
        } else if (content.includes('Access Denied')) {
             addLog(`[Worker ${workerId}] ❌ Failed: Access Denied at final step.`);
             return { success: false };
        } else {
            addLog(`[Worker ${workerId}] ❌ Failed. Could not find OTP page.`);
            return { success: false };
        }

    } catch (err) {
        addLog(`[Worker ${workerId}] Error: ${err.message}`);
        return { success: false };
    } finally {
        if (browser) await browser.close();
    }
}

app.get('/api/emails', (req, res) => {
    res.json({ emails: liveEmails, logs: liveLogs });
});

app.post('/api/reset', (req, res) => {
    liveEmails = [];
    liveLogs = [];
    addLog("Reset successful.");
    res.json({ message: 'Cleared' });
});

app.post('/api/start', async (req, res) => {
    if (isRunning) {
        return res.status(400).json({ message: "Already running! Please wait." });
    }

    const count = parseInt(req.body.count) || 1;
    isRunning = true;
    addLog(`🚀 Started request for ${count} account(s)...`);
    
    res.json({ message: `Started ${count} workers. Watch logs below.` });

    for (let i = 1; i <= count; i++) {
        await createAccount(i);
        await new Promise(r => setTimeout(r, 3000));
    }
    
    isRunning = false;
    addLog(`✅ All workers finished.`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🌐 Server running on port ${PORT}`);
});
