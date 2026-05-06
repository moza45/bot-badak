require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
// ╔══════════════════════════════════════════════════════════════╗
// ║         W A - K I C K E R   B O T   v 5 . 1 . 0            ║
// ║      G O D M O D E   E D I T I O N   (FULL FIXED)          ║
// ╚══════════════════════════════════════════════════════════════╝

// ========== KONFIGURASI AWAL ==========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN tidak ditemukan di .env!');
    process.exit(1);
}

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
    .split(',')
    .map(id => parseInt(id.trim()))
    .filter(id => !isNaN(id));

if (ADMIN_IDS.length === 0) {
    console.error('❌ ADMIN_IDS tidak ditemukan atau tidak valid di .env!');
    process.exit(1);
}

const BOT_NAME             = process.env.BOT_NAME || '⚡ WA Kicker Bot';
const PAYMENT_BANK_NAME    = process.env.PAYMENT_BANK_NAME   || 'SEA';
const PAYMENT_BANK_NUMBER  = process.env.PAYMENT_BANK_NUMBER || '1234567890';
const PAYMENT_BANK_HOLDER  = process.env.PAYMENT_BANK_HOLDER || 'Bot Owner';
const PAYMENT_DANA         = process.env.PAYMENT_DANA        || '081234567890';
const PAYMENT_CONTACT      = process.env.PAYMENT_CONTACT     || '@adminusername';
const TRIAL_DURATION_HOURS = parseInt(process.env.TRIAL_DURATION_HOURS || '24');
const KICK_LIMIT_PER_SESSION = parseInt(process.env.KICK_LIMIT || '20');
const HEALTH_API_KEY = process.env.HEALTH_API_KEY || crypto.randomBytes(16).toString('hex');

const PAYMENT_INFO =
    `Transfer ke:\n` +
    `🏦 ${PAYMENT_BANK_NAME}: ${PAYMENT_BANK_NUMBER} a/n ${PAYMENT_BANK_HOLDER}\n` +
    `💚 Dana/Shopeepay: ${PAYMENT_DANA}`;

const PACKAGES = {
    '1bulan':  { label: '1 Bulan',  days: 30,  price: parseInt(process.env.PRICE_1BULAN  || '50000')  },
    '3bulan':  { label: '3 Bulan',  days: 90,  price: parseInt(process.env.PRICE_3BULAN  || '125000') },
    '6bulan':  { label: '6 Bulan',  days: 180, price: parseInt(process.env.PRICE_6BULAN  || '200000') },
    '1tahun':  { label: '1 Tahun',  days: 365, price: parseInt(process.env.PRICE_1TAHUN  || '350000') } };

// ========== PERSISTENT STORAGE UNTUK RAILWAY ==========
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const AUTH_BASE_FOLDER = path.join(DATA_DIR, 'auth_states');

if (!fs.existsSync(AUTH_BASE_FOLDER)) fs.mkdirSync(AUTH_BASE_FOLDER, { recursive: true });

// ========== DATABASE JSON (PURE JS - NO COMPILE NEEDED) ==========
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PAYMENTS_FILE = path.join(DATA_DIR, 'payments.json');

function readJSON(filePath, defaultVal = {}) {
    try {
        if (!fs.existsSync(filePath)) return defaultVal;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) { return defaultVal; }
}

function writeJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

class UserDatabase {
    getUser(userId) {
        const users = readJSON(USERS_FILE);
        const u = users[String(userId)];
        return u || null;
    }

    saveUser(user) {
        const users = readJSON(USERS_FILE);
        users[String(user.id)] = {
            ...user,
            hadTrial: user.hadTrial ? 1 : 0,
            notifiedExpiry: user.notifiedExpiry ? 1 : 0,
            updatedAt: new Date().toISOString()
        };
        writeJSON(USERS_FILE, users);
    }

    getAllUsers() {
        const users = readJSON(USERS_FILE);
        return Object.values(users);
    }

    deleteUser(userId) {
        const users = readJSON(USERS_FILE);
        delete users[String(userId)];
        writeJSON(USERS_FILE, users);
    }

    getAllPendingPayments() {
        const payments = readJSON(PAYMENTS_FILE);
        return Object.values(payments);
    }

    addPendingPayment(payment) {
        const payments = readJSON(PAYMENTS_FILE);
        payments[String(payment.id)] = payment;
        writeJSON(PAYMENTS_FILE, payments);
    }

    removePendingPayment(userId) {
        const payments = readJSON(PAYMENTS_FILE);
        delete payments[String(userId)];
        writeJSON(PAYMENTS_FILE, payments);
    }

    updateNotifiedFlag(userId) {
        const users = readJSON(USERS_FILE);
        if (users[String(userId)]) {
            users[String(userId)].notifiedExpiry = 1;
            writeJSON(USERS_FILE, users);
        }
    }
}
const db = new UserDatabase();

// ========== LOGGER (FIX SILENT CATCH) ==========
const LOG_LEVELS = { INFO: '📘', WARN: '⚠️', ERROR: '❌', DEBUG: '🐛' };

function log(level, module, message, error = null) {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} ${LOG_LEVELS[level]} [${module}] ${message}`;
    console.log(logEntry);
    if (error && level === 'ERROR') {
        console.error(error.stack);
        fs.appendFileSync(path.join(DATA_DIR, 'error.log'), `${logEntry}\n${error?.stack || ''}\n\n`);
    }
}

// ========== GLOBAL STATE ==========
const tgBot = new Telegraf(TELEGRAM_BOT_TOKEN);
const userSessions = new Map();
const kickSelections = new Map();
const loginLocks = new Map();
const conflictCooldowns = new Map();
const reconnectAttempts = new Map();
const vcfPending = new Map();
const CONFLICT_COOLDOWN_MS = 35000;
const MAX_RECONNECT_ATTEMPTS = 3;
const MAX_CONCURRENT_SESSIONS = 50;
const SESSION_IDLE_MS = 4 * 60 * 60 * 1000;

// ========== RATE LIMITER ==========
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX = 5;

function isRateLimited(userId) {
    const now = Date.now();
    const entry = rateLimitMap.get(userId) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    if (now > entry.resetAt) {
        entry.count = 1;
        entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
    } else {
        entry.count++;
    }
    rateLimitMap.set(userId, entry);
    return entry.count > RATE_LIMIT_MAX;
}

// ========== SAFE REPLY (FIX MARKDOWN CRASH) ==========
async function safeReply(ctx, text, opts = {}) {
    // Selalu coba dengan Markdown dulu
    const mdOpts = { parse_mode: 'Markdown', ...opts };
    try {
        return await ctx.reply(text, mdOpts);
    } catch (err) {
        if (err.message && (err.message.includes("parse entities") || err.message.includes("Bad Request"))) {
            // Fallback 1: strip parse_mode, escape semua karakter spesial
            const { parse_mode, ...safeOpts } = mdOpts;
            try {
                return await ctx.reply(text.replace(/[*_`[\]()~>#+=|{}.!\\-]/g, "\\$&"), { ...safeOpts });
            } catch (err2) {
                // Fallback 2: kirim teks polos tanpa karakter markdown sama sekali
                return await ctx.reply(text.replace(/[*_`[\]()~>#+=|{}.!\\-]/g, ""), safeOpts);
            }
        }
        log("WARN", "SafeReply", `Gagal kirim pesan: ${err.message}`);
    }
}

// ========== MEMORY MONITOR ==========
setInterval(() => {
    const mem = process.memoryUsage();
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    log("INFO", "Memory", `Heap: ${heapMB}MB | RSS: ${rssMB}MB | Sessions: ${userSessions.size}`);
    if (heapMB > 400) log("WARN", "Memory", `Heap tinggi (${heapMB}MB)`);
}, 30 * 60 * 1000);

// ========== AUTO BACKUP JSON ==========
const BACKUP_DIR = path.join(DATA_DIR, "backups");
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function backupData() {
    try {
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const usersFile = path.join(DATA_DIR, "users.json");
        const paymentsFile = path.join(DATA_DIR, "payments.json");
        if (fs.existsSync(usersFile)) fs.copyFileSync(usersFile, path.join(BACKUP_DIR, `users_${ts}.json`));
        if (fs.existsSync(paymentsFile)) fs.copyFileSync(paymentsFile, path.join(BACKUP_DIR, `payments_${ts}.json`));
        const files = fs.readdirSync(BACKUP_DIR).sort();
        const userB = files.filter(f => f.startsWith("users_"));
        const payB  = files.filter(f => f.startsWith("payments_"));
        userB.slice(0, Math.max(0, userB.length - 24)).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
        payB.slice(0, Math.max(0, payB.length - 24)).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
        log("INFO", "Backup", `Backup berhasil: ${ts}`);
    } catch (err) {
        log("ERROR", "Backup", `Gagal backup: ${err.message}`, err);
    }
}
setInterval(backupData, 60 * 60 * 1000);
setTimeout(backupData, 5000);

// ========== SESSION CLEANUP (FIX MEMORY LEAK) ==========
setInterval(async () => {
    const now = Date.now();
    for (const [userId, session] of userSessions.entries()) {
        if (session.lastActivity && (now - session.lastActivity) > SESSION_IDLE_MS) {
            log('INFO', 'Cleanup', `Auto-cleanup session idle untuk user ${userId}`);
            await destroySession(userId);
        }
    }
    if (userSessions.size > MAX_CONCURRENT_SESSIONS) {
        log('WARN', 'Cleanup', `Melebihi batas session (${userSessions.size}), cleanup forced`);
        const oldest = [...userSessions.entries()].sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0))[0];
        if (oldest) await destroySession(oldest[0]);
    }
}, 30 * 60 * 1000);

function touchSession(userId) {
    const sess = userSessions.get(userId);
    if (sess) sess.lastActivity = Date.now();
}

// ========== FUNGSI HELPERS ==========
function isAdmin(userId) {
    return ADMIN_IDS.includes(userId);
}

async function getUser(userId) {
    if (isAdmin(userId)) return { id: userId, role: 'admin' };
    return await db.getUser(userId);
}

async function getUserStatus(userId) {
    if (isAdmin(userId)) return 'admin';
    const u = await getUser(userId);
    if (!u) return 'none';
    if (u.role === 'regular') {
        return new Date(u.expiresAt) > new Date() ? 'regular' : 'expired';
    }
    if (u.role === 'trial') {
        return new Date(u.trialExpiresAt) > new Date() ? 'trial' : 'trial_expired';
    }
    return 'none';
}

async function canUseBot(userId) {
    const status = await getUserStatus(userId);
    return ['admin', 'regular', 'trial'].includes(status);
}

async function isTrialOnly(userId) {
    return (await getUserStatus(userId)) === 'trial';
}

async function startTrial(user) {
    const existing = await getUser(user.id);
    if (existing) return { success: false, reason: 'already_user' };
    
    const allUsers = await db.getAllUsers();
    const hadTrial = allUsers.some(u => String(u.id) === String(user.id) && u.hadTrial);
    if (hadTrial) return { success: false, reason: 'used_trial' };
    
    const now = new Date();
    const exp = new Date(now.getTime() + TRIAL_DURATION_HOURS * 60 * 60 * 1000);
    const newUser = {
        id: user.id,
        username: user.username || null,
        firstName: user.first_name || '',
        lastName: user.last_name || '',
        role: 'trial',
        trialExpiresAt: exp.toISOString(),
        hadTrial: 1,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
    };
    await db.saveUser(newUser);
    return { success: true, user: newUser, expiresAt: exp };
}

async function addPendingPayment(user, packageKey) {
    await db.addPendingPayment({
        id: user.id,
        username: user.username || null,
        firstName: user.first_name || '',
        lastName: user.last_name || '',
        packageKey,
        requestedAt: new Date().toISOString()
    });
}

async function approvePayment(userId, packageKey) {
    const pkg = PACKAGES[packageKey];
    if (!pkg) return { success: false, reason: 'invalid_package' };
    
    const pendingPayments = await db.getAllPendingPayments();
    const userInfo = pendingPayments.find(p => p.id === userId);
    await db.removePendingPayment(userId);
    
    const existing = await db.getUser(userId);
    const now = new Date();
    let expiresAt;
    
    if (existing) {
        const base = existing.expiresAt && new Date(existing.expiresAt) > now
            ? new Date(existing.expiresAt)
            : now;
        expiresAt = new Date(base.getTime() + pkg.days * 24 * 60 * 60 * 1000);
        await db.saveUser({
            ...existing,
            role: 'regular',
            expiresAt: expiresAt.toISOString(),
            lastPackage: packageKey,
            updatedAt: now.toISOString()
        });
    } else {
        expiresAt = new Date(now.getTime() + pkg.days * 24 * 60 * 60 * 1000);
        await db.saveUser({
            id: userId,
            username: userInfo?.username || null,
            firstName: userInfo?.firstName || '',
            lastName: userInfo?.lastName || '',
            role: 'regular',
            expiresAt: expiresAt.toISOString(),
            lastPackage: packageKey,
            hadTrial: 1,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString()
        });
    }
    
    return { success: true, expiresAt, pkg };
}

async function revokeUser(userId) {
    const user = await db.getUser(userId);
    if (!user) return null;
    await db.deleteUser(userId);
    return user;
}

async function getAllUsers() {
    return await db.getAllUsers();
}

async function getAllPendingPayments() {
    return await db.getAllPendingPayments();
}

function formatDate(isoStr) {
    if (!isoStr) return '-';
    return new Date(isoStr).toLocaleString('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta'
    });
}

function formatCountdown(isoStr) {
    const ms = new Date(isoStr) - new Date();
    if (ms <= 0) return 'SUDAH EXPIRED';
    const hours = Math.floor(ms / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        return `${days} hari ${hours % 24} jam`;
    }
    return `${hours} jam ${mins} menit`;
}

function formatRupiah(num) {
    return 'Rp ' + num.toLocaleString('id-ID');
}

function esc(text) {
    if (!text) return '';
    return String(text).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}

function userDisplayName(u) {
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Tanpa Nama';
    const uname = u.username ? ` (@${u.username})` : '';
    return `${name}${uname}`;
}

function userDisplayNameEsc(u) {
    const name = esc([u.firstName, u.lastName].filter(Boolean).join(' ') || 'Tanpa Nama');
    const uname = u.username ? ` (@${esc(u.username)})` : '';
    return `${name}${uname}`;
}

const DIVIDER = '━━━━━━━━━━━━━━━━━━━━━━';
const DIVIDER_THIN = '┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄';

// ========== HUMAN DELAY FUNCTIONS ==========
async function humanDelay(minMs = 1200, maxMs = 3800) {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1) + minMs);
    return new Promise(resolve => setTimeout(resolve, delay));
}

async function humanDelayKick() {
    const r = Math.random();
    let delaySec;
    if (r < 0.3) delaySec = 12 + Math.random() * 6;
    else if (r < 0.7) delaySec = 20 + Math.random() * 10;
    else delaySec = 32 + Math.random() * 13;
    delaySec = delaySec * (0.9 + Math.random() * 0.2);
    log('INFO', 'HumanDelay', `Jeda antar kick: ${Math.round(delaySec)} detik`);
    return new Promise(r => setTimeout(r, Math.floor(delaySec * 1000)));
}

async function humanDelayAdd() {
    const r = Math.random();
    let delaySec;
    if (r < 0.4) delaySec = 8 + Math.random() * 7;
    else if (r < 0.8) delaySec = 16 + Math.random() * 6;
    else delaySec = 23 + Math.random() * 3;
    delaySec = delaySec * (0.85 + Math.random() * 0.3);
    log('INFO', 'HumanDelay', `Jeda antar add: ${Math.round(delaySec)} detik`);
    return new Promise(r => setTimeout(r, Math.floor(delaySec * 1000)));
}

async function humanDelayBatchPause() {
    const r = Math.random();
    let delaySec;
    if (r < 0.4) delaySec = 20 + Math.random() * 20;
    else if (r < 0.7) delaySec = 40 + Math.random() * 20;
    else delaySec = 60 + Math.random() * 30;
    log('INFO', 'HumanDelay', `Jeda antar batch: ${Math.round(delaySec)} detik`);
    return new Promise(r => setTimeout(r, Math.floor(delaySec * 1000)));
}

async function humanDelayError() {
    const delaySec = 45 + Math.random() * 75;
    log('INFO', 'HumanDelay', `Jeda setelah error: ${Math.round(delaySec)} detik`);
    return new Promise(r => setTimeout(r, Math.floor(delaySec * 1000)));
}

async function humanDelayNatural(minSec = 3, maxSec = 25) {
    const delaySec = minSec + Math.random() * (maxSec - minSec);
    return new Promise(r => setTimeout(r, Math.floor(delaySec * 1000)));
}

async function simulateReadAndType(sock, jid, shouldType = false) {
    try {
        await sock.sendPresenceUpdate('available');
        await humanDelayNatural(1, 3);
        if (shouldType && Math.random() > 0.3) {
            await sock.sendPresenceUpdate('composing', jid);
            await humanDelayNatural(2, 6);
            await sock.sendPresenceUpdate('paused', jid);
        }
        await humanDelayNatural(1, 4);
    } catch (err) {
        log('WARN', 'Simulate', `Gagal simulasi typing: ${err.message}`);
    }
}

function isActiveHours() {
    const hour = new Date().toLocaleString('en-US', {
        timeZone: 'Asia/Jakarta',
        hour: 'numeric',
        hour12: false
    });
    const h = parseInt(hour);
    return h >= 8 && h <= 22;
}

// ========== DYNAMIC FINGERPRINT ==========
function generateDynamicFingerprint() {
    const chromeVersions = ['120', '121', '122', '123', '124'];
    const edgeVersions = ['120', '121', '122'];
    const safariVersions = ['16', '17', '17.4'];
    const osList = ['Windows', 'MacOS', 'Linux'];
    const os = osList[Math.floor(Math.random() * osList.length)];
    
    let browser, version;
    if (os === 'MacOS') {
        browser = 'Safari';
        version = safariVersions[Math.floor(Math.random() * safariVersions.length)];
    } else if (Math.random() > 0.3) {
        browser = 'Chrome';
        version = chromeVersions[Math.floor(Math.random() * chromeVersions.length)];
    } else {
        browser = 'Edge';
        version = edgeVersions[Math.floor(Math.random() * edgeVersions.length)];
    }
    
    const buildId = Math.floor(Math.random() * 9999);
    let userAgent = '';
    if (browser === 'Chrome') {
        userAgent = `Mozilla/5.0 (${os === 'Windows' ? 'Windows NT 10.0; Win64; x64' : 'Macintosh; Intel Mac OS X 10_15_7'}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.${buildId}.${Math.floor(Math.random() * 99)} Safari/537.36`;
    } else if (browser === 'Edge') {
        userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36 Edg/${version}.0.${buildId}`;
    } else {
        userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Safari/605.1.15`;
    }
    return [os, browser, `${version}.0.${buildId}`, userAgent];
}

function getEncryptedAuthFolder(userId) {
    const epochWeek = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
    const hash = crypto.createHash('sha256')
        .update(`wa_${userId}_v3_${epochWeek}`)
        .digest('hex')
        .substring(0, 32);
    return path.join(AUTH_BASE_FOLDER, hash);
}

// ========== BACKGROUND ACTIVITY SPOOFER (FIXED) ==========
async function startBackgroundActivitySpooler(sock, userId) {
    let isActive = true;
    const activities = [
        () => sock.sendPresenceUpdate('available'),
        () => sock.sendPresenceUpdate('unavailable'),
        () => sock.sendPresenceUpdate('recording'),
        () => sock.sendPresenceUpdate('paused'),
    ];
    
    const runActivity = async () => {
        if (!isActive) return;
        const session = userSessions.get(userId);
        if (!session?.loggedIn) return;
        
        const interval = (5 + Math.random() * 20) * 60 * 1000;
        setTimeout(async () => {
            try {
                const act = activities[Math.floor(Math.random() * activities.length)];
                await act();
                if (Math.random() > 0.7 && session.groupId) {
                    await humanDelayNatural(0.5, 2);
                    await sock.sendPresenceUpdate('composing', session.groupId);
                    await humanDelayNatural(1, 4);
                    await sock.sendPresenceUpdate('paused', session.groupId);
                }
            } catch (err) {
                log('WARN', 'Spoofer', `Gagal kirim presence update: ${err.message}`);
                await new Promise(r => setTimeout(r, 60000));
            }
            runActivity();
        }, interval);
    };
    runActivity();
    return () => { isActive = false; };
}

// ========== ANIMATIONS ==========
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const CLOCK_FRAMES = ['🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕛'];
const PULSE_FRAMES = ['🔴', '🟠', '🟡', '🟢', '🟡', '🟠'];

async function liveMessage(ctx, initText, frameFn, interval = 900) {
    let msg;
    try {
        msg = await ctx.reply(initText, { parse_mode: 'Markdown' });
    } catch (err) {
        try {
            msg = await safeReply(ctx, initText);
        } catch (err2) {
            log('WARN', 'LiveMsg', `Gagal kirim pesan: ${err2.message}`);
            return { stop: async () => {} };
        }
    }

    let frame = 0, stopped = false;
    const timer = setInterval(async () => {
        if (stopped) return;
        try {
            const text = frameFn(frame);
            await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined, text, { parse_mode: 'Markdown' });
        } catch (err) {
            // Abaikan error edit message (biasanya karena sudah dihapus)
        }
        frame++;
    }, interval);

    return {
        stop: async (finalText) => {
            stopped = true;
            clearInterval(timer);
            if (finalText) {
                try {
                    await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined, finalText, { parse_mode: 'Markdown' });
                } catch (err) {
                    // Abaikan
                }
            }
        }
    };
}

async function spinnerMessage(ctx, label) {
    return liveMessage(ctx, `${SPINNER_FRAMES[0]} *${label}*`, (i) => `${SPINNER_FRAMES[i % SPINNER_FRAMES.length]} *${label}*`, 750);
}

function buildProgressBar(done, total, width = 14) {
    const pct = total === 0 ? 1 : Math.min(done / total, 1);
    const filled = Math.round(pct * width);
    const empty = width - filled;
    return '[' + '█'.repeat(filled) + '░'.repeat(empty) + '] ' + String(Math.round(pct * 100)).padStart(3) + '%';
}

async function liveKickProgress(ctx, total) {
    let current = 0;
    const anim = await liveMessage(ctx,
        `🦵 *Memulai kick...*\n${buildProgressBar(0, total)}\n0/${total} orang`,
        (i) => {
            const spin = SPINNER_FRAMES[i % SPINNER_FRAMES.length];
            const pulse = PULSE_FRAMES[i % PULSE_FRAMES.length];
            return `${pulse} *Sedang mengkick anggota...*\n\n${buildProgressBar(current, total)}\n${spin} \`${current}/${total}\` orang dikick\n\n_Sabar, jeda antar kick untuk stealth mode..._`;
        }, 800);
    return {
        update: (n) => { current = n; },
        stop: (finalText) => anim.stop(finalText)
    };
}

async function liveCountdown(ctx, totalMs, headerText, onDone) {
    const endTime = Date.now() + totalMs;
    const anim = await liveMessage(ctx, `⏳ ${headerText}\n\nMenghitung...`,
        (i) => {
            const left = Math.max(0, endTime - Date.now());
            const sisa = Math.ceil(left / 1000);
            const clock = CLOCK_FRAMES[i % CLOCK_FRAMES.length];
            const pulse = PULSE_FRAMES[i % PULSE_FRAMES.length];
            const menit = String(Math.floor(sisa / 60)).padStart(2, '0');
            const detik = String(sisa % 60).padStart(2, '0');
            const bar = buildProgressBar(totalMs - left, totalMs, 14);
            return `${pulse} ${headerText}\n\n${clock} Sisa waktu: \`${menit}:${detik}\`\n${bar}\n\n_WA server lagi ngelepas koneksi lama..._`;
        }, 1000);
    setTimeout(async () => {
        await anim.stop(`✅ Cooldown selesai!\n\nSilakan tekan 🔑 Login WhatsApp lagi.`);
        if (onDone) onDone();
    }, totalMs);
    return anim;
}

async function liveConnecting(ctx) {
    const labels = ['Menyiapkan koneksi WA', 'Memuat auth session', 'Menghubungi server WA', 'Menunggu QR code'];
    let phase = 0;
    return liveMessage(ctx, `${CLOCK_FRAMES[0]} Menyambungkan ke WhatsApp...`,
        (i) => {
            if (i > 0 && i % 4 === 0 && phase < labels.length - 1) phase++;
            const spin = SPINNER_FRAMES[i % SPINNER_FRAMES.length];
            const clock = CLOCK_FRAMES[i % CLOCK_FRAMES.length];
            return `${clock} Menghubungkan ke WhatsApp\n\n${spin} ${labels[phase]}...\n\n_QR code akan muncul sebentar lagi_`;
        }, 700);
}

// ========== QR SENDER ==========
async function sendQR(ctx, qr) {
    if (!qr) {
        await safeReply(ctx, `❌ QR code kosong, coba lagi.`);
        return;
    }
    await humanDelay(1800, 3600);
    const sendAsText = Math.random() < 0.25;
    try {
        if (!sendAsText) {
            const qrBuffer = await QRCode.toBuffer(qr, { type: 'png', width: 1024, margin: 2, color: { dark: '#000000', light: '#FFFFFF' }, scale: 8 });
            await ctx.replyWithPhoto({ source: qrBuffer }, {
                caption: `📱 SCAN QR CODE DI WHATSAPP\n\n1. Buka WhatsApp di HP\n2. Tap ⋮ (titik tiga) → Perangkat Tertaut\n3. Tap Tautkan Perangkat\n4. Scan QR code di atas\n\n_Kalo gagal scan, screenshot aja terus scan dari galeri_`});
        } else {
            await safeReply(ctx, `📱 SCAN QR CODE MANUAL\n\n1. Buka WhatsApp → Perangkat Tertaut\n2. Tautkan Perangkat\n3. Scan kode dibawah (screenshot):\n\n\`\`\`\n${qr}\n\`\`\``);
        }
    } catch (err) {
        await safeReply(ctx, `📱 SCAN QR CODE (Teks Backup)\n\n\`\`\`\n${qr}\n\`\`\``);
    }
}

// ========== STEALTH KICK ==========
async function burstThenPauseKick(sock, groupId, jids, onProgress) {
    let totalKicked = 0;
    let i = 0;
    const shuffledJids = [...jids];
    for (let iIdx = shuffledJids.length - 1; iIdx > 0; iIdx--) {
        const j = Math.floor(Math.random() * (iIdx + 1));
        [shuffledJids[iIdx], shuffledJids[j]] = [shuffledJids[j], shuffledJids[iIdx]];
    }
    
    while (i < shuffledJids.length) {
        const burstSize = Math.floor(Math.random() * 4) + 1;
        const batch = shuffledJids.slice(i, i + burstSize);
        try {
            await simulateReadAndType(sock, groupId, false);
            await sock.groupParticipantsUpdate(groupId, batch, 'remove');
            totalKicked += batch.length;
            if (onProgress) onProgress(totalKicked);
            log('INFO', 'Kick', `Berhasil kick ${batch.length} orang (total: ${totalKicked}/${shuffledJids.length})`);
            if (i + burstSize < shuffledJids.length) await humanDelayBatchPause();
        } catch (err) {
            log('ERROR', 'Kick', `Gagal kick batch: ${err.message}`, err);
            await humanDelayError();
        }
        i += burstSize;
    }
    return totalKicked;
}

// ========== DESTROY SESSION ==========
async function destroySession(userId) {
    const old = userSessions.get(userId);
    if (!old) return;
    if (old.qrTimer) clearTimeout(old.qrTimer);
    if (old.reconnTimer) clearTimeout(old.reconnTimer);
    try {
        old.sock.ev.removeAllListeners();
        old.sock.end(new Error('destroyed'));
    } catch (err) {
        log('WARN', 'Destroy', `Gagal destroy session: ${err.message}`);
    }
    userSessions.delete(userId);
    await new Promise(r => setTimeout(r, 3500));
}

// ========== LOGIN ==========
async function startLogin(ctx, userId) {
    const cooldownUntil = conflictCooldowns.get(userId);
    if (cooldownUntil && Date.now() < cooldownUntil) {
        const sisaDetik = Math.ceil((cooldownUntil - Date.now()) / 1000);
        return safeReply(ctx, `⏳ Harap tunggu ${sisaDetik} detik lagi\n\nWA server masih melepas koneksi sebelumnya.\n_(anti Stream Conflict aktif)_`);
    }
    if (loginLocks.get(userId)) {
        return safeReply(ctx, `⏳ Proses login sedang berjalan, harap tunggu...`);
    }
    loginLocks.set(userId, true);
    try {
        if (userSessions.has(userId)) {
            await safeReply(ctx, `🔄 _Menutup koneksi lama..._`);
            await destroySession(userId);
        }
        const authFolder = getEncryptedAuthFolder(userId);
        const { version } = await fetchLatestBaileysVersion();
        const browserProfile = generateDynamicFingerprint();
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);
        const connectAnim = await liveConnecting(ctx);
        const sock = makeWASocket({
            auth: state,
            browser: browserProfile,
            logger: pino({ level: 'silent' }),
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 30000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 500,
            version,
            generateHighQualityLinkPreview: false,
            printQRInTerminal: false,
            shouldReconnect: () => false });
        const session = {
            sock, saveCreds,
            qrTimer: null, reconnTimer: null,
            lastQR: null, qrBlocked: false,
            loggedIn: false, groupId: null, groupName: null, members: [],
            _groupPickerList: null,
            _vcfGroupPickerList: null,
            createdAt: Date.now(),
            lastActivity: Date.now()
        };
        userSessions.set(userId, session);
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                session.lastQR = qr;
                if (!session.qrBlocked) {
                    session.qrBlocked = true;
                    try { await connectAnim.stop(null); } catch (err) {}
                    await sendQR(ctx, qr);
                    session.qrTimer = setTimeout(async () => {
                        if (!session.loggedIn) {
                            session.qrBlocked = false;
                            await safeReply(ctx, `⏱ QR expired. Ketik /refreshqr untuk QR baru.`);
                        }
                    }, 60000);
                }
            }
            if (connection === 'close') {
                if (session.qrTimer) clearTimeout(session.qrTimer);
                if (session.reconnTimer) clearTimeout(session.reconnTimer);
                const err = lastDisconnect?.error;
                const statusCode = err?.output?.statusCode ?? err?.output?.payload?.statusCode;
                const attempts = (reconnectAttempts.get(userId) || 0) + 1;
                log('INFO', 'Connection', `[${userId}] WA close — code=${statusCode}, attempt=${attempts}`);
                if (statusCode === 515) {
                    sock.ev.removeAllListeners();
                    userSessions.delete(userId);
                    reconnectAttempts.delete(userId);
                    conflictCooldowns.set(userId, Date.now() + CONFLICT_COOLDOWN_MS);
                    try { await connectAnim.stop(null); } catch (err) {}
                    await safeReply(ctx, `⚠️ Stream Conflict (515)\n\nWA mendeteksi koneksi ganda dari device yang sama.\n\nPenyebab umum:\n• Bot di-restart terlalu cepat\n• Ada instance bot lain aktif\n• Session belum dilepas server WA`);
                    await liveCountdown(ctx, CONFLICT_COOLDOWN_MS, 'Cooldown Stream Conflict', () => { conflictCooldowns.delete(userId); });
                    return;
                }
                if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                    sock.ev.removeAllListeners();
                    userSessions.delete(userId);
                    reconnectAttempts.delete(userId);
                    await safeReply(ctx, `🚫 Session ditolak WhatsApp.\n\nLogin ulang diperlukan.\nTekan 🔑 Login WhatsApp`);
                    return;
                }
                if (attempts <= MAX_RECONNECT_ATTEMPTS) {
                    reconnectAttempts.set(userId, attempts);
                    const delayMs = Math.min(5000 * Math.pow(2, attempts - 1), 30000);
                    const delaySec = Math.ceil(delayMs / 1000);
                    sock.ev.removeAllListeners();
                    userSessions.delete(userId);
                    await safeReply(ctx, `🔌 Koneksi terputus (code: ${statusCode || '?'}).\n🔄 Reconnect otomatis dalam ${delaySec} detik... (percobaan ${attempts}/${MAX_RECONNECT_ATTEMPTS})`);
                    const reconnTimer = setTimeout(async () => {
                        try { await startLogin(ctx, userId); }
                        catch (e) { log('ERROR', 'Login', 'Auto-reconnect error', e); }
                    }, delayMs);
                    // Simpan timer di Map agar bisa di-cancel kalau user logout manual
                    const pendingReconn = userSessions.get(userId);
                    if (pendingReconn) pendingReconn.reconnTimer = reconnTimer;
                    else {
                        // Buat entry sementara untuk menyimpan timer
                        userSessions.set(userId, { reconnTimer, loggedIn: false, _pendingReconn: true });
                    }
                } else {
                    sock.ev.removeAllListeners();
                    userSessions.delete(userId);
                    reconnectAttempts.delete(userId);
                    await safeReply(ctx, `❌ Koneksi gagal setelah ${MAX_RECONNECT_ATTEMPTS}x percobaan.\n\nTekan 🔑 Login WhatsApp untuk coba manual.`);
                }
            }
            if (connection === 'open') {
                session.loggedIn = true;
                if (session.qrTimer) clearTimeout(session.qrTimer);
                reconnectAttempts.delete(userId);
                conflictCooldowns.delete(userId);
                try { await connectAnim.stop(null); } catch (err) {}
                try { await sock.sendPresenceUpdate('available'); } catch (err) {}
                startBackgroundActivitySpooler(sock, userId);
                const kb = isAdmin(userId) ? KB_ADMIN_MAIN : KB_MAIN;
                await safeReply(ctx, `✅ LOGIN WHATSAPP BERHASIL!\n\nPilih menu di keyboard bawah.`, { ...kb });
            }
        });
        sock.ev.on('creds.update', () => { saveCreds(); });
    } catch (err) {
        log('ERROR', 'Login', `Gagal start login: ${err.message}`, err);
        await safeReply(ctx, `❌ Gagal login: ${esc(err.message)}`);
    } finally {
        loginLocks.delete(userId);
    }
}

// ========== KEYBOARDS ==========
const KB_LANDING = {
    reply_markup: {
        keyboard: [[{ text: '🎁 Coba Gratis (Trial)' }, { text: '⭐ Premium' }], [{ text: '❓ Bantuan' }]],
        resize_keyboard: true, one_time_keyboard: false
    }
};
const KB_PRE_LOGIN = {
    reply_markup: {
        keyboard: [[{ text: '🔑 Login WhatsApp' }], [{ text: '📊 Status' }, { text: '👤 Akun Saya' }], [{ text: '⭐ Premium' }, { text: '❓ Bantuan' }]],
        resize_keyboard: true, one_time_keyboard: false
    }
};
const KB_MAIN = {
    reply_markup: {
        keyboard: [[{ text: '📋 Daftar Grup' }, { text: '🎯 Pilih Grup' }], [{ text: '➕ Buat Grup WA' }, { text: '📥 Import VCF' }], [{ text: '🔴 Kick Menu' }, { text: '📡 Status' }], [{ text: '🚪 Logout WhatsApp' }]],
        resize_keyboard: true, one_time_keyboard: false
    }
};
const KB_ADMIN_PRE = {
    reply_markup: {
        keyboard: [[{ text: '🔑 Login WhatsApp' }], [{ text: '📋 Pending Payment' }, { text: '👥 User List' }], [{ text: '📊 Status' }, { text: '❓ Bantuan' }]],
        resize_keyboard: true, one_time_keyboard: false
    }
};
const KB_ADMIN_MAIN = {
    reply_markup: {
        keyboard: [[{ text: '📋 Daftar Grup' }, { text: '🎯 Pilih Grup' }], [{ text: '➕ Buat Grup WA' }, { text: '📥 Import VCF' }], [{ text: '🔴 Kick Menu' }, { text: '📡 Status' }], [{ text: '📋 Pending Payment' }, { text: '👥 User List' }], [{ text: '🚪 Logout WhatsApp' }]],
        resize_keyboard: true, one_time_keyboard: false
    }
};

async function getKeyboard(userId) {
    const loggedIn = userSessions.get(userId)?.loggedIn;
    if (isAdmin(userId)) return loggedIn ? KB_ADMIN_MAIN : KB_ADMIN_PRE;
    const status = await getUserStatus(userId);
    if (status === 'regular' || status === 'trial') return loggedIn ? KB_MAIN : KB_PRE_LOGIN;
    return KB_LANDING;
}

async function requireAccess(ctx, next) {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (isAdmin(userId)) return next();
    const status = await getUserStatus(userId);
    if (status === 'regular' || status === 'trial') return next();
    if (status === 'expired') {
        return safeReply(ctx, `╔${DIVIDER}╗\n║  AKSES BERAKHIR\n╚${DIVIDER}╝\n\nPaket lo sudah expired.\nPerpanjang sekarang!\n\nKetik /beli untuk lihat paket.`, { ...KB_LANDING });
    }
    if (status === 'trial_expired') {
        return safeReply(ctx, `╔${DIVIDER}╗\n║  TRIAL BERAKHIR\n╚${DIVIDER}╝\n\nMasa trial lo sudah habis.\nUpgrade ke paket reguler!\n\nKetik /beli untuk lihat paket.`, { ...KB_LANDING });
    }
    await safeReply(ctx, `╔${DIVIDER}╗\n║  AKSES DITOLAK\n╚${DIVIDER}╝\n\nBot ini berbayar.\n\n🎁 Coba gratis ${TRIAL_DURATION_HOURS} jam → tekan tombol Coba Gratis\n💳 Atau langsung beli paket → tekan ⭐ Premium`, { ...KB_LANDING });
}

// ========== GROUP & KICK MENU ==========
async function showGroupPicker(ctx, userId, session) {
    const fetchAnim = await spinnerMessage(ctx, 'Mengambil daftar grup...');
    try {
        const chats = await session.sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        if (groups.length === 0) {
            await fetchAnim.stop(`❌ Tidak ada grup ditemukan.`);
            return;
        }
        const isTrial = await isTrialOnly(userId);
        const displayGroups = isTrial ? groups.slice(0, 1) : groups;
        session._groupPickerList = displayGroups;
        const buttons = displayGroups.map((g, i) => {
            const memberCount = g.participants?.length || 0;
            const label = `${i + 1}. ${g.subject} (${memberCount} 👥)`.substring(0, 64);
            return [Markup.button.callback(label, `selectgrp_${i}`)];
        });
        buttons.push([Markup.button.callback('❌ Batal', 'selectgrp_cancel')]);
        await fetchAnim.stop(null);
        let header = `╔${DIVIDER}╗\n║  PILIH GRUP\n╚${DIVIDER}╝\n\n`;
        if (isTrial) header += `⚠️ _Trial: hanya 1 grup_\n\n`;
        header += `Ketuk nama grup yang ingin dipilih:`;
        await safeReply(ctx, header, { reply_markup: { inline_keyboard: buttons } });
    } catch (err) {
        await fetchAnim.stop(`❌ Error: ${esc(err.message)}`);
    }
}

function buildMemberKeyboard(members, selected) {
    const buttons = [];
    for (const m of members) {
        const isSelected = selected.has(m.jid);
        buttons.push([Markup.button.callback(`${isSelected ? '✅' : '⬜'} ${m.name.substring(0, 25)}`, `toggle_${m.jid}`)]);
    }
    buttons.push([Markup.button.callback('🔨 KICK TERPILIH', 'do_kick')]);
    buttons.push([Markup.button.callback('❌ BATAL', 'cancel_kick')]);
    return { reply_markup: { inline_keyboard: buttons } };
}

async function showKickMenu(ctx, userId, session) {
    const fetchAnim = await spinnerMessage(ctx, 'Mengambil daftar anggota...');
    try {
        const metadata = await session.sock.groupMetadata(session.groupId);
        const myJid = session.sock.user.id.replace(/:.*@/, '@');
        const allMembers = metadata.participants.filter(p => {
            const isMe = p.id === myJid || p.id.split('@')[0] === myJid.split('@')[0];
            const isAdm = p.admin === 'admin' || p.admin === 'superadmin';
            return !isMe && !isAdm;
        }).map(p => ({ jid: p.id, name: p.id.split('@')[0] }));
        if (allMembers.length === 0) {
            await fetchAnim.stop(null);
            return safeReply(ctx, `ℹ️ Tidak ada anggota yang bisa dikick.\n\nSemua anggota adalah admin.`);
        }
        const members = allMembers.slice(0, KICK_LIMIT_PER_SESSION);
        const limited = allMembers.length > KICK_LIMIT_PER_SESSION;
        session.members = members;
        kickSelections.set(userId, new Set());
        await fetchAnim.stop(null);
        let infoText = '';
        if (limited) infoText = `\n⚠️ _Ditampilkan ${KICK_LIMIT_PER_SESSION} dari ${allMembers.length} anggota (batas per sesi)_`;
        await safeReply(ctx, `╔${DIVIDER}╗\n║  MENU KICK ANGGOTA\n╚${DIVIDER}╝\n\n🎯 Grup: ${esc(session.groupName || '')}\n👥 Non-admin: ${members.length} orang${infoText}\n\nKetuk nama untuk pilih/batal.\nTekan Kick Terpilih jika sudah siap.\n\n⚠️ _Aksi kick tidak bisa dibatalkan!_`, { ...buildMemberKeyboard(members, kickSelections.get(userId)) });
    } catch (err) {
        await fetchAnim.stop(`❌ Error: ${esc(err.message)}`);
    }
}

// ========== VCF PARSER ==========
function decodeQP(str) {
    return str.replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function normalizePhone(raw) {
    const hasPlus = raw.trimStart().startsWith('+');
    let digits = raw.replace(/\D/g, '');
    if (!digits) return null;
    if (hasPlus || digits.startsWith('00')) {
        const withCC = hasPlus ? digits : digits.slice(2);
        if (withCC.length >= 7) return withCC;
    }
    if (digits.startsWith('0')) return '62' + digits.slice(1);
    if (digits.startsWith('62')) return digits;
    if (digits.length >= 9) return '62' + digits;
    return digits.length >= 7 ? digits : null;
}

function parseVCF(vcfText) {
    const contacts = [];
    const seen = new Set();
    const blocks = vcfText.split(/END:VCARD/i).map(b => b.trim()).filter(Boolean);
    for (const block of blocks) {
        let name = 'Tanpa Nama';
        const fnMatch = block.match(/^FN[;:][^\r\n]*/mi);
        const nMatch = block.match(/^N[;:][^\r\n]*/mi);
        if (fnMatch) {
            const qpMatch = fnMatch[0].match(/ENCODING=QUOTED-PRINTABLE.*?:(.*)/i);
            if (qpMatch) {
                try { name = decodeQP(qpMatch[1].trim()); } catch (err) {}
            } else {
                name = fnMatch[0].replace(/^FN.*?:/i, '').trim();
            }
        } else if (nMatch) {
            const raw = nMatch[0].replace(/^N.*?:/i, '').trim();
            const parts = raw.split(';').map(p => p.trim()).filter(Boolean);
            name = parts.slice(0, 2).reverse().join(' ').trim() || 'Tanpa Nama';
        }
        name = name.replace(/[\x00-\x1F]/g, '').trim() || 'Tanpa Nama';
        const telLines = block.match(/^TEL[^\r\n]*/gim) || [];
        for (const telLine of telLines) {
            let num = telLine.replace(/^TEL[^:]*:/i, '').replace(/[\s\-().]/g, '').trim();
            if (!num) continue;
            num = normalizePhone(num);
            if (!num) continue;
            if (seen.has(num)) continue;
            seen.add(num);
            contacts.push({ name, phone: num });
        }
    }
    return contacts;
}

async function addContactsToGroup(ctx, userId, contacts, groupId, groupName) {
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) {
        return safeReply(ctx, '❌ Session WA berakhir. Tekan 🔑 Login WhatsApp.');
    }
    const total = contacts.length;
    let berhasil = 0, gagal = 0, notWA = 0;
    const statusMsg = await safeReply(ctx, `⏳ Menambahkan ${total} kontak ke grup...`);
    for (let i = 0; i < contacts.length; i++) {
        const c = contacts[i];
        try {
            const [result] = await session.sock.onWhatsApp(c.phone);
            if (!result || !result.exists) {
                notWA++;
                log('INFO', 'Add', `${c.phone} => No WA`);
                continue;
            }
            await simulateReadAndType(session.sock, groupId, true);
            await session.sock.groupParticipantsUpdate(groupId, [result.jid], 'add');
            berhasil++;
            log('INFO', 'Add', `✅ ${c.name} (${c.phone}) berhasil ditambahkan`);
            if (i + 1 < contacts.length) await humanDelayAdd();
            if ((i + 1) % 3 === 0 || i + 1 === total) {
                try {
                    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `⏳ Progres: ${i + 1}/${total}\n✅ Berhasil: ${berhasil} | 📵 No WA: ${notWA}`);
                } catch (err) {}
            }
        } catch (err) {
            gagal++;
            log('ERROR', 'Add', `${c.phone}: ${err.message}`, err);
            await humanDelayError();
        }
    }
    let hasil = `╔${DIVIDER}╗\n║  HASIL IMPORT VCF\n╚${DIVIDER}╝\n\n🎯 Grup: ${groupName}\n\n${DIVIDER_THIN}\n✅ Berhasil ditambah: ${berhasil} kontak\n📵 Tidak punya WA: ${notWA} kontak\n❌ Error: ${gagal} kontak\n`;
    await safeReply(ctx, hasil);
    vcfPending.delete(userId);
}

// ========== SHOW PRICE MENU ==========
async function showPriceMenu(ctx) {
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(`📦 1 Bulan — ${formatRupiah(PACKAGES['1bulan'].price)}`, 'buy_1bulan')],
        [Markup.button.callback(`📦 3 Bulan — ${formatRupiah(PACKAGES['3bulan'].price)}`, 'buy_3bulan')],
        [Markup.button.callback(`📦 6 Bulan — ${formatRupiah(PACKAGES['6bulan'].price)}`, 'buy_6bulan')],
        [Markup.button.callback(`🏆 1 Tahun — ${formatRupiah(PACKAGES['1tahun'].price)}`, 'buy_1tahun')],
    ]);
    await safeReply(ctx, `╔${DIVIDER}╗\n║  PAKET HARGA\n╚${DIVIDER}╝\n\n📦 1 Bulan → ${formatRupiah(PACKAGES['1bulan'].price)}\n📦 3 Bulan → ${formatRupiah(PACKAGES['3bulan'].price)}\n📦 6 Bulan → ${formatRupiah(PACKAGES['6bulan'].price)}\n🏆 1 Tahun → ${formatRupiah(PACKAGES['1tahun'].price)}\n\nPilih paket di bawah:`, { ...keyboard });
}

// ========== TELEGRAM COMMANDS ==========
// ========== RATE LIMIT MIDDLEWARE ==========
tgBot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId && isRateLimited(userId)) {
        try { await safeReply(ctx, '⏳ Terlalu cepat! Tunggu beberapa detik.'); } catch (e) {}
        return;
    }
    return next();
});

tgBot.start(async (ctx) => {
    const userId = ctx.from.id;
    const name = ctx.from.first_name || 'User';
    const status = await getUserStatus(userId);
    const loggedIn = userSessions.get(userId)?.loggedIn;
    const kb = await getKeyboard(userId);
    if (isAdmin(userId)) {
        return safeReply(ctx, `╔${DIVIDER}╗\n║  ${BOT_NAME}\n╚${DIVIDER}╝\n\n👑 Selamat datang, Admin ${esc(name)}!\n\n${DIVIDER_THIN}\n${loggedIn ? `✅ WA: *Terhubung*\n\n*Pilih menu di keyboard bawah:*` : `🔴 WA: *Belum login*\n\nTekan *🔑 Login WhatsApp* untuk mulai.`}`, { ...kb });
    }
    if (status === 'regular') {
        const u = await getUser(userId);
        return safeReply(ctx, `╔${DIVIDER}╗\n║  ${BOT_NAME}\n╚${DIVIDER}╝\n\n✅ Halo ${esc(name)}!\n\n${DIVIDER_THIN}\n🏷️ Status: Premium Aktif\n📅 Hingga: ${formatDate(u.expiresAt)}\n⏳ Sisa: ${formatCountdown(u.expiresAt)}\n${DIVIDER_THIN}\n\n${loggedIn ? `📡 WA: *Terhubung* ✅` : `🔴 WA: *Belum login*`}`, { ...kb });
    }
    if (status === 'trial') {
        const u = await getUser(userId);
        return safeReply(ctx, `╔${DIVIDER}╗\n║  ${BOT_NAME}\n╚${DIVIDER}╝\n\n🎁 Halo ${esc(name)}!\n\n${DIVIDER_THIN}\n🏷️ Status: Trial Aktif\n⏱ Habis: ${formatDate(u.trialExpiresAt)}\n⏳ Sisa: ${formatCountdown(u.trialExpiresAt)}\n${DIVIDER_THIN}\n\n${loggedIn ? `📡 WA: *Terhubung* ✅` : `🔴 WA: *Belum login*`}`, { ...kb });
    }
    if (status === 'expired' || status === 'trial_expired') {
        return safeReply(ctx, `⚠️ Akses lo sudah berakhir.\nPerpanjang untuk bisa pakai lagi!`, { ...kb });
    }
    await safeReply(ctx, `👋 Halo ${esc(name)}!\n\nBot ini membantu lo kick anggota grup WhatsApp.\n\n🎁 COBA GRATIS ${TRIAL_DURATION_HOURS} JAM\n⭐ PREMIUM — akses penuh\n\nPilih di keyboard bawah:`, { ...kb });
});

tgBot.command('trial', async (ctx) => {
    const user = ctx.from;
    const status = await getUserStatus(user.id);
    if (status === 'admin') return safeReply(ctx, '👑 Lo adalah admin.', await getKeyboard(user.id));
    if (status === 'regular') return safeReply(ctx, '✅ Lo sudah punya akses reguler.', await getKeyboard(user.id));
    if (status === 'trial') {
        const u = await getUser(user.id);
        return safeReply(ctx, `⏱ Masih trial. Sisa: ${formatCountdown(u.trialExpiresAt)}`, { ...KB_PRE_LOGIN });
    }
    const result = await startTrial(user);
    if (!result.success) return safeReply(ctx, `❌ Gagal: ${result.reason}`);
    await safeReply(ctx, `🎉 TRIAL AKTIF!\n\n✅ ${TRIAL_DURATION_HOURS} jam\n⏱ Berakhir: ${formatDate(result.expiresAt.toISOString())}\n\nTekan 🔑 Login WhatsApp untuk mulai!`, { ...KB_PRE_LOGIN });
});

tgBot.command('beli', async (ctx) => {
    if (isAdmin(ctx.from.id)) return safeReply(ctx, '👑 Kamu adalah admin. Tidak perlu beli paket.');
    await showPriceMenu(ctx);
});

Object.keys(PACKAGES).forEach(pkgKey => {
    tgBot.action(`buy_${pkgKey}`, async (ctx) => {
        await ctx.answerCbQuery();
        if (isAdmin(ctx.from.id)) {
            return safeReply(ctx, '👑 Kamu adalah admin. Tidak perlu beli paket.');
        }
        const pkg = PACKAGES[pkgKey];
        const user = ctx.from;
        await addPendingPayment(user, pkgKey);
        for (const adminId of ADMIN_IDS) {
            try {
                const approveKeyboard = Markup.inlineKeyboard([[Markup.button.callback(`✅ Approve`, `admin_approve_${user.id}_${pkgKey}`), Markup.button.callback(`❌ Reject`, `admin_reject_${user.id}`)]]);
                await tgBot.telegram.sendMessage(adminId, `🔔 Permintaan Beli\n👤 ${userDisplayNameEsc(user)}\n📦 ${pkg.label} \(${formatRupiah(pkg.price)}\)`, { parse_mode: 'Markdown', ...approveKeyboard });
            } catch (err) {
                log('WARN', 'Payment', `Gagal kirim ke admin ${adminId}: ${err.message}`);
            }
        }
        await safeReply(ctx, `✅ Permintaan diterima!\n\n💰 ${formatRupiah(pkg.price)}\n${PAYMENT_INFO}\n\nKonfirmasi ke ${PAYMENT_CONTACT} dengan format: KICKER-${user.id}-${pkgKey}`);
    });
});

tgBot.action(/^admin_approve_(\d+)_(\w+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();
    const targetId = parseInt(ctx.match[1]);
    const pkgKey = ctx.match[2];
    const result = await approvePayment(targetId, pkgKey);
    if (!result.success) return ctx.editMessageText(`❌ Gagal: ${result.reason}`);
    await ctx.editMessageText(`✅ APPROVED!\nID: ${targetId}\nPaket: ${result.pkg.label}\nAktif hingga: ${formatDate(result.expiresAt.toISOString())}`);
    try {
        await tgBot.telegram.sendMessage(targetId, `🎉 PEMBAYARAN DIKONFIRMASI!\n\n📦 ${result.pkg.label}\n📅 Aktif hingga: ${formatDate(result.expiresAt.toISOString())}\n\nTekan 🔑 Login WhatsApp untuk mulai.`, { parse_mode: 'Markdown', ...KB_PRE_LOGIN });
    } catch (err) {
        log('WARN', 'Payment', `Gagal kirim konfirmasi ke user ${targetId}: ${err.message}`);
    }
});

tgBot.action(/^admin_reject_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();
    const targetId = parseInt(ctx.match[1]);
    await db.removePendingPayment(targetId);
    await ctx.editMessageText(`❌ REJECTED\nID: ${targetId}`);
    try {
        await tgBot.telegram.sendMessage(targetId, `❌ Pembayaran ditolak.\nHubungi ${PAYMENT_CONTACT}`, { parse_mode: 'Markdown', ...KB_LANDING });
    } catch (err) {}
});

tgBot.command('login', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (session && session.loggedIn) return safeReply(ctx, '✅ Lo udah login!');
    await safeReply(ctx, `🔄 Memulai koneksi...`);
    try {
        await startLogin(ctx, userId);
    } catch (err) {
        log('ERROR', 'Login', err.message, err);
        await safeReply(ctx, `❌ Gagal: ${esc(err.message)}`);
    }
});

tgBot.command('refreshqr', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session) return safeReply(ctx, '❌ Belum ada sesi.');
    if (session.loggedIn) return safeReply(ctx, '✅ Sudah login!');
    if (!session.lastQR) return safeReply(ctx, '⏳ QR belum tersedia.');
    await sendQR(ctx, session.lastQR);
});

tgBot.command('logout', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    if (!userSessions.has(userId)) return safeReply(ctx, '❌ Belum login!');
    try {
        await destroySession(userId);
        const authFolder = getEncryptedAuthFolder(userId);
        if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
        kickSelections.delete(userId);
        reconnectAttempts.delete(userId);
        conflictCooldowns.delete(userId);
        loginLocks.delete(userId);
        await safeReply(ctx, '✅ Logout berhasil.', { ...KB_PRE_LOGIN });
    } catch (err) {
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
    }
});

tgBot.command('groups', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return safeReply(ctx, '❌ Login dulu!');
    await showGroupPicker(ctx, userId, session);
});

tgBot.command('select', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return safeReply(ctx, '❌ Login dulu!');
    const groupName = ctx.message.text.replace('/select', '').trim().replace(/^["']|["']$/g, '');
    if (groupName) {
        try {
            const chats = await session.sock.groupFetchAllParticipating();
            const groups = Object.values(chats);
            const isTrial = await isTrialOnly(userId);
            const allowedGroups = isTrial ? groups.slice(0, 1) : groups;
            const target = allowedGroups.find(g => g.subject.toLowerCase() === groupName.toLowerCase());
            if (!target) return safeReply(ctx, `❌ Grup "${groupName}" tidak ditemukan.`);
            session.groupId = target.id;
            session.groupName = target.subject;
            await safeReply(ctx, `✅ Grup terpilih!\n🎯 ${esc(target.subject)}\n👥 ${target.participants?.length || 0} anggota\n\nTekan 🔴 Kick Menu untuk mulai.`);
        } catch (err) {
            await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
        }
    } else {
        await showGroupPicker(ctx, userId, session);
    }
});

tgBot.command('kickmenu', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return safeReply(ctx, '❌ *Login dulu!*');
    if (!session.groupId) return safeReply(ctx, '❌ *Pilih grup dulu!*');
    await showKickMenu(ctx, userId, session);
});

tgBot.command('buatgrup', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return safeReply(ctx, '❌ *Login dulu!*');
    const namaGrup = ctx.message.text.replace('/buatgrup', '').trim().replace(/^["']|["']$/g, '');
    if (!namaGrup) return safeReply(ctx, 'Format: /buatgrup "Nama Grup"');
    await safeReply(ctx, `⏳ *Membuat grup "${namaGrup}"...*`);
    try {
        const result = await session.sock.groupCreate(namaGrup, []);
        session.groupId = result.id;
        session.groupName = namaGrup;
        let inviteLink = '-';
        try {
            const code = await session.sock.groupInviteCode(result.id);
            inviteLink = `https://chat.whatsapp.com/${code}`;
        } catch (err) {}
        await safeReply(ctx, `✅ Grup berhasil dibuat!\n\n${namaGrup}\n🔗 ${inviteLink}\n\nTekan 🔴 Kick Menu untuk mulai.`);
    } catch (err) {
        await safeReply(ctx, `❌ Gagal: ${esc(err.message)}`);
    }
});

tgBot.command('importvcf', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return safeReply(ctx, '❌ Login dulu!');
    const fetchAnim = await spinnerMessage(ctx, 'Mengambil daftar grup...');
    try {
        const chats = await session.sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        if (groups.length === 0) {
            await fetchAnim.stop(`❌ Tidak ada grup ditemukan.`);
            return;
        }
        const isTrial = await isTrialOnly(userId);
        const displayGroups = isTrial ? groups.slice(0, 1) : groups;
        session._vcfGroupPickerList = displayGroups;
        const buttons = displayGroups.map((g, i) => {
            const memberCount = g.participants?.length || 0;
            const label = `${i + 1}. ${g.subject} (${memberCount} 👥)`.substring(0, 64);
            return [Markup.button.callback(label, `vcfgrp_${i}`)];
        });
        buttons.push([Markup.button.callback('❌ Batal', 'vcfgrp_cancel')]);
        await fetchAnim.stop(null);
        let header = `╔${DIVIDER}╗\n║  PILIH GRUP TUJUAN VCF\n╚${DIVIDER}╝\n\n`;
        if (isTrial) header += `⚠️ _Trial: hanya 1 grup_\n\n`;
        header += `Pilih grup yang akan ditambahkan kontaknya:`;
        await safeReply(ctx, header, { reply_markup: { inline_keyboard: buttons } });
    } catch (err) {
        await fetchAnim.stop(`❌ Error: ${esc(err.message)}`);
    }
});

tgBot.command('status', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    const accStatus = await getUserStatus(userId);
    const u = await getUser(userId);
    let waStatus = '🔴 Belum Login';
    if (session && !session.loggedIn) waStatus = '🟡 Menunggu QR';
    if (session && session.loggedIn) waStatus = '🟢 Terhubung';
    let accLine = '';
    if (accStatus === 'admin') accLine = '👑 Admin';
    else if (accStatus === 'regular') accLine = `⭐ Reguler (${formatCountdown(u?.expiresAt)})`;
    else if (accStatus === 'trial') accLine = `🎁 Trial (${formatCountdown(u?.trialExpiresAt)})`;
    await safeReply(ctx, `📡 WA: ${waStatus}\n🏷️ Akun: ${accLine}\n🎯 Grup: ${session?.groupName || 'Belum pilih'}`);
});

tgBot.command('myaccount', async (ctx) => {
    const userId = ctx.from.id;
    const status = await getUserStatus(userId);
    if (status === 'admin') return safeReply(ctx, `👑 Admin bot.`);
    const u = await getUser(userId);
    if (!u) return safeReply(ctx, `Belum terdaftar. Tekan 🎁 Coba Gratis`, { ...KB_LANDING });
    await safeReply(ctx, `👤 ${userDisplayNameEsc(u)}\n🆔 ${u.id}\nStatus: ${status}\nExp: ${u.expiresAt ? formatDate(u.expiresAt) : u.trialExpiresAt ? formatDate(u.trialExpiresAt) : '-'}`);
});


// ========== HELP TEXT (SAFE, NO MARKDOWN CRASH) ==========
function getHelpText(contact) {
    return [
        "Panduan Penggunaan WA Kicker Bot",
        "",
        "1. Daftar dan Aktifkan Akses",
        "   Tekan Coba Gratis untuk trial gratis 24 jam",
        "   Tekan Premium untuk beli paket reguler",
        "",
        "2. Login WhatsApp",
        "   Tekan Login WhatsApp lalu scan QR di WA kamu",
        "",
        "3. Pilih Grup",
        "   Tekan Daftar Grup atau Pilih Grup",
        "   Ketuk nama grup dari daftar",
        "",
        "4. Import VCF",
        "   Tekan Import VCF, pilih grup, kirim file .vcf",
        "",
        "5. Kick Anggota",
        "   Tekan Kick Menu, centang anggota, tekan Kick",
        "",
        "PENTING:",
        "- Bot hanya bisa kick jika kamu admin grup",
        "- Akun WA yang login harus jadi admin di grup target",
        "- Trial hanya bisa akses 1 grup",
        "",
        "Butuh bantuan? Hubungi " + contact
    ].join("\n");
}

tgBot.command('help', async (ctx) => {
    await safeReply(ctx, getHelpText(PAYMENT_CONTACT));
});

tgBot.command('pendingpayment', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const list = await getAllPendingPayments();
    if (list.length === 0) return safeReply(ctx, `📭 Kosong.`);
    let msg = `PENDING: ${list.length}\n\n`;
    for (const p of list) {
        msg += `👤 ${p.id}\n📦 ${p.packageKey}\n📅 ${formatDate(p.requestedAt)}\n\n`;
    }
    await safeReply(ctx, msg);
});

tgBot.command('userlist', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return safeReply(ctx, '⛔ Akses ditolak.');
    const users = await getAllUsers();
    if (users.length === 0) return safeReply(ctx, 'Belum ada user terdaftar.');
    const now = new Date();
    const actives = users.filter(u => {
        const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
        return exp && new Date(exp) > now;
    });
    const expired = users.filter(u => {
        const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
        return !exp || new Date(exp) <= now;
    });
    let msg = `╔${DIVIDER}╗\n║  DAFTAR USER\n╚${DIVIDER}╝\n\n✅ Aktif: ${actives.length}  |  ❌ Expired: ${expired.length}\n\n`;
    if (actives.length > 0) {
        msg += `${DIVIDER_THIN}\n✅ USER AKTIF:\n${DIVIDER_THIN}\n`;
        actives.forEach((u, i) => {
            const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
            const role = u.role === 'trial' ? '🎁 Trial' : '⭐ Reguler';
            msg += `${i + 1}. ${userDisplayNameEsc(u)}\n   ID: \`${u.id}\` | ${role}\n   Exp: ${formatDate(exp)} (${formatCountdown(exp)})\n\n`;
        });
    }
    if (expired.length > 0 && expired.length <= 10) {
        msg += `${DIVIDER_THIN}\n❌ EXPIRED:\n${DIVIDER_THIN}\n`;
        expired.forEach((u, i) => {
            const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
            msg += `${i + 1}. ${userDisplayNameEsc(u)} | ID: \`${u.id}\`\n   Expired: ${formatDate(exp)}\n\n`;
        });
    } else if (expired.length > 10) {
        msg += `\n_(+${expired.length} user expired tidak ditampilkan)_`;
    }
    msg += `\n\n/revokeuser [id] — Cabut akses`;
    await safeReply(ctx, msg);
});

tgBot.command('revokeuser', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return safeReply(ctx, '⛔ Akses ditolak.');
    const args = ctx.message.text.split(' ');
    const targetId = parseInt(args[1]);
    if (!targetId) return safeReply(ctx, `Format: /revokeuser [user_id]`);
    const user = await revokeUser(targetId);
    if (!user) return safeReply(ctx, `❌ User ID ${targetId} tidak ditemukan.`);
    if (userSessions.has(targetId)) {
        const session = userSessions.get(targetId);
        if (session.qrTimer) clearTimeout(session.qrTimer);
        try { session.sock.end(new Error('revoked')); } catch (err) {}
        userSessions.delete(targetId);
    }
    kickSelections.delete(targetId);
    reconnectAttempts.delete(targetId);
    conflictCooldowns.delete(targetId);
    loginLocks.delete(targetId);
    await safeReply(ctx, `🚫 Akses ${userDisplayName(user)} (ID: ${targetId}) dicabut.`);
    try {
        await tgBot.telegram.sendMessage(targetId, `⚠️ Akses lo ke ${BOT_NAME} telah dicabut oleh admin.\n\nHubungi ${PAYMENT_CONTACT} jika ada pertanyaan.`, { parse_mode: 'Markdown', ...KB_LANDING });
    } catch (err) {}
});

tgBot.command('adduser', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return safeReply(ctx, '⛔ Akses ditolak.');
    const args = ctx.message.text.split(' ');
    const targetId = parseInt(args[1]);
    const pkgKey = args[2];
    if (!targetId || !pkgKey || !PACKAGES[pkgKey]) {
        return safeReply(ctx, `Format: /adduser [user_id] [paket]\n\nPaket: 1bulan / 3bulan / 6bulan / 1tahun`);
    }
    const result = await approvePayment(targetId, pkgKey);
    if (!result.success) return safeReply(ctx, `❌ Gagal: ${result.reason}`);
    await safeReply(ctx, `✅ User berhasil ditambahkan!\n\n🆔 ID: \`${targetId}\`\n📦 Paket: ${result.pkg.label}\n📅 Aktif hingga: ${formatDate(result.expiresAt.toISOString())}`);
    try {
        await tgBot.telegram.sendMessage(targetId, `🎉 Akses ke ${BOT_NAME} sudah diaktifkan!\n\n📦 Paket: ${result.pkg.label}\n📅 Aktif hingga: ${formatDate(result.expiresAt.toISOString())}\n\nTekan 🔑 Login WhatsApp untuk mulai.`, { parse_mode: 'Markdown', ...KB_PRE_LOGIN });
    } catch (err) {}
});

// ========== HEARS HANDLERS ==========
tgBot.hears('🎁 Coba Gratis (Trial)', async (ctx) => {
    const user = ctx.from;
    const status = await getUserStatus(user.id);
    if (status === 'regular') return safeReply(ctx, '✅ Sudah punya akses.', await getKeyboard(user.id));
    if (status === 'trial') {
        const u = await getUser(user.id);
        return safeReply(ctx, `⏱ Masih trial: ${formatCountdown(u.trialExpiresAt)}`, { ...KB_PRE_LOGIN });
    }
    const result = await startTrial(user);
    if (!result.success) return safeReply(ctx, `❌ ${result.reason}`);
    await safeReply(ctx, `🎉 TRIAL AKTIF!\n\nTekan 🔑 Login WhatsApp untuk mulai.`, { ...KB_PRE_LOGIN });
});

tgBot.hears('⭐ Premium', async (ctx) => {
    if (isAdmin(ctx.from.id)) return safeReply(ctx, '👑 Kamu adalah admin. Tidak perlu beli paket.');
    await showPriceMenu(ctx);
});

tgBot.hears('❓ Bantuan', async (ctx) => {
    await safeReply(ctx, getHelpText(PAYMENT_CONTACT));
});

tgBot.hears('🔑 Login WhatsApp', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (session && session.loggedIn) return safeReply(ctx, '✅ Lo udah login!');
    await safeReply(ctx, `🔄 Memulai koneksi...`);
    try {
        await startLogin(ctx, userId);
    } catch (err) {
        await safeReply(ctx, `❌ Gagal: ${esc(err.message)}`);
    }
});

tgBot.hears('📊 Status', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    const accStatus = await getUserStatus(userId);
    const u = await getUser(userId);
    let waStatus = '🔴 Belum Login';
    if (session && !session.loggedIn) waStatus = '🟡 Menunggu QR';
    if (session && session.loggedIn) waStatus = '🟢 Terhubung';
    let accLine = '';
    if (accStatus === 'admin') accLine = '👑 Admin';
    else if (accStatus === 'regular') accLine = `⭐ Reguler (${formatCountdown(u?.expiresAt)})`;
    else if (accStatus === 'trial') accLine = `🎁 Trial (${formatCountdown(u?.trialExpiresAt)})`;
    await safeReply(ctx, `📡 WA: ${waStatus}\n🏷️ Akun: ${accLine}\n🎯 Grup: ${session?.groupName || 'Belum pilih'}`);
});

tgBot.hears('👤 Akun Saya', async (ctx) => {
    const userId = ctx.from.id;
    const status = await getUserStatus(userId);
    if (status === 'admin') return safeReply(ctx, `👑 Admin bot.`);
    const u = await getUser(userId);
    if (!u) return safeReply(ctx, `Belum terdaftar. Tekan 🎁 Coba Gratis`, { ...KB_LANDING });
    await safeReply(ctx, `👤 ${userDisplayNameEsc(u)}\n🆔 ${u.id}\nStatus: ${status}\nExp: ${u.expiresAt ? formatDate(u.expiresAt) : u.trialExpiresAt ? formatDate(u.trialExpiresAt) : '-'}`);
});

tgBot.hears('📋 Daftar Grup', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return safeReply(ctx, '❌ Login dulu!');
    await showGroupPicker(ctx, userId, session);
});

tgBot.hears('🎯 Pilih Grup', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return safeReply(ctx, '❌ Login dulu!');
    await showGroupPicker(ctx, userId, session);
});

tgBot.hears('➕ Buat Grup WA', requireAccess, async (ctx) => {
    await safeReply(ctx, `Format: /buatgrup "Nama Grup"\n\nContoh: /buatgrup "Arisan RT 05"`);
});

tgBot.hears('📥 Import VCF', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return safeReply(ctx, '❌ Login dulu!');
    const fetchAnim = await spinnerMessage(ctx, 'Mengambil daftar grup...');
    try {
        const chats = await session.sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        if (groups.length === 0) {
            await fetchAnim.stop(`❌ Tidak ada grup ditemukan.`);
            return;
        }
        const isTrial = await isTrialOnly(userId);
        const displayGroups = isTrial ? groups.slice(0, 1) : groups;
        session._vcfGroupPickerList = displayGroups;
        const buttons = displayGroups.map((g, i) => {
            const memberCount = g.participants?.length || 0;
            const label = `${i + 1}. ${g.subject} (${memberCount} 👥)`.substring(0, 64);
            return [Markup.button.callback(label, `vcfgrp_${i}`)];
        });
        buttons.push([Markup.button.callback('❌ Batal', 'vcfgrp_cancel')]);
        await fetchAnim.stop(null);
        let header = `╔${DIVIDER}╗\n║  PILIH GRUP TUJUAN VCF\n╚${DIVIDER}╝\n\n`;
        if (isTrial) header += `⚠️ _Trial: hanya 1 grup_\n\n`;
        header += `Pilih grup yang akan ditambahkan kontaknya:`;
        await safeReply(ctx, header, { reply_markup: { inline_keyboard: buttons } });
    } catch (err) {
        await fetchAnim.stop(`❌ Error: ${esc(err.message)}`);
    }
});

tgBot.hears('🔴 Kick Menu', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return safeReply(ctx, '❌ Login dulu!');
    if (!session.groupId) return safeReply(ctx, '❌ Pilih grup dulu!');
    await showKickMenu(ctx, userId, session);
});

tgBot.hears('📡 Status', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    const accStatus = await getUserStatus(userId);
    const u = await getUser(userId);
    let waStatus = '🔴 Belum Login';
    if (session && !session.loggedIn) waStatus = '🟡 Menunggu QR';
    if (session && session.loggedIn) waStatus = '🟢 Terhubung';
    let accLine = '';
    if (accStatus === 'admin') accLine = '👑 Admin';
    else if (accStatus === 'regular') accLine = `⭐ Reguler (${formatCountdown(u?.expiresAt)})`;
    else if (accStatus === 'trial') accLine = `🎁 Trial (${formatCountdown(u?.trialExpiresAt)})`;
    await safeReply(ctx, `📡 WA: ${waStatus}\n🏷️ Akun: ${accLine}\n🎯 Grup: ${session?.groupName || 'Belum pilih'}`);
});

tgBot.hears('🚪 Logout WhatsApp', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    if (!userSessions.has(userId)) return safeReply(ctx, '❌ Belum login!');
    try {
        await destroySession(userId);
        const authFolder = getEncryptedAuthFolder(userId);
        if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
        kickSelections.delete(userId);
        reconnectAttempts.delete(userId);
        conflictCooldowns.delete(userId);
        loginLocks.delete(userId);
        await safeReply(ctx, '✅ Logout berhasil.', { ...KB_PRE_LOGIN });
    } catch (err) {
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
    }
});

tgBot.hears('📋 Pending Payment', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const list = await getAllPendingPayments();
    if (list.length === 0) return safeReply(ctx, `📭 Kosong.`);
    let msg = `PENDING: ${list.length}\n\n`;
    for (const p of list) {
        msg += `👤 ${p.id}\n📦 ${p.packageKey}\n📅 ${formatDate(p.requestedAt)}\n\n`;
    }
    await safeReply(ctx, msg);
});

tgBot.hears('👥 User List', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return safeReply(ctx, '⛔ Akses ditolak.');
    const users = await getAllUsers();
    if (users.length === 0) return safeReply(ctx, 'Belum ada user terdaftar.');
    const now = new Date();
    const actives = users.filter(u => {
        const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
        return exp && new Date(exp) > now;
    });
    const expired = users.filter(u => {
        const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
        return !exp || new Date(exp) <= now;
    });
    let msg = `╔${DIVIDER}╗\n║  DAFTAR USER\n╚${DIVIDER}╝\n\n✅ Aktif: ${actives.length}  |  ❌ Expired: ${expired.length}\n\n`;
    if (actives.length > 0) {
        msg += `${DIVIDER_THIN}\n✅ USER AKTIF:\n${DIVIDER_THIN}\n`;
        actives.forEach((u, i) => {
            const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
            const role = u.role === 'trial' ? '🎁 Trial' : '⭐ Reguler';
            msg += `${i + 1}. ${userDisplayNameEsc(u)}\n   ID: \`${u.id}\` | ${role}\n   Exp: ${formatDate(exp)} (${formatCountdown(exp)})\n\n`;
        });
    }
    if (expired.length > 0 && expired.length <= 10) {
        msg += `${DIVIDER_THIN}\n❌ EXPIRED:\n${DIVIDER_THIN}\n`;
        expired.forEach((u, i) => {
            const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
            msg += `${i + 1}. ${userDisplayNameEsc(u)} | ID: \`${u.id}\`\n   Expired: ${formatDate(exp)}\n\n`;
        });
    } else if (expired.length > 10) {
        msg += `\n_(+${expired.length} user expired tidak ditampilkan)_`;
    }
    msg += `\n\n/revokeuser [id] — Cabut akses`;
    await safeReply(ctx, msg);
});

// ========== DOCUMENT HANDLER (VCF) ==========
tgBot.on('document', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const pending = vcfPending.get(userId);
    if (!pending || !pending.waitingFile) return;
    const doc = ctx.message.document;
    const fname = doc.file_name || '';
    if (!fname.toLowerCase().endsWith('.vcf')) {
        return safeReply(ctx, '⚠️ File harus .vcf');
    }
    await safeReply(ctx, '⏳ Membaca file VCF...');
    try {
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const resp = await fetch(fileLink.href);
        const vcfText = await resp.text();
        const contacts = parseVCF(vcfText);
        if (contacts.length === 0) {
            vcfPending.delete(userId);
            return safeReply(ctx, '❌ Tidak ada nomor valid.');
        }
        pending.contacts = contacts;
        pending.waitingFile = false;
        vcfPending.set(userId, pending);
        const keyboard = Markup.inlineKeyboard([[Markup.button.callback(`✅ Tambah Semua (${contacts.length})`, 'vcf_add_all')], [Markup.button.callback('❌ Batal', 'vcf_cancel')]]);
        await safeReply(ctx, `📊 ${contacts.length} kontak ditemukan.\n🎯 Grup tujuan: ${pending.groupName}\n\nTambahkan sekarang?`, { ...keyboard });
    } catch (err) {
        vcfPending.delete(userId);
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
    }
});

// ========== INLINE BUTTON HANDLERS ==========
tgBot.action(/^selectgrp_(\d+|cancel)$/, requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    await ctx.answerCbQuery();
    const param = ctx.match[1];
    const session = userSessions.get(userId);
    if (param === 'cancel') {
        if (session) session._groupPickerList = null;
        return ctx.editMessageText('✖ Pemilihan grup dibatalkan.');
    }
    if (!session || !session.loggedIn) {
        return ctx.editMessageText('❌ Session habis. Login ulang.');
    }
    const idx = parseInt(param);
    const groupList = session._groupPickerList;
    if (!groupList || idx >= groupList.length) {
        return ctx.editMessageText('❌ Data grup tidak ditemukan. Coba lagi.');
    }
    const target = groupList[idx];
    session.groupId = target.id;
    session.groupName = target.subject;
    session._groupPickerList = null;
    const memberCount = target.participants?.length || 0;
    await ctx.editMessageText(`✅ Grup terpilih!\n\n🎯 ${esc(target.subject)}\n👥 ${memberCount} anggota\n\nTekan 🔴 Kick Menu untuk mulai.`);
});

tgBot.action(/^vcfgrp_(\d+|cancel)$/, requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    await ctx.answerCbQuery();
    const param = ctx.match[1];
    const session = userSessions.get(userId);
    if (param === 'cancel') {
        if (session) session._vcfGroupPickerList = null;
        return ctx.editMessageText('✖ Import VCF dibatalkan.');
    }
    if (!session || !session.loggedIn) {
        return ctx.editMessageText('❌ Session habis. Login ulang.');
    }
    const idx = parseInt(param);
    const groupList = session._vcfGroupPickerList;
    if (!groupList || idx >= groupList.length) {
        return ctx.editMessageText('❌ Data grup tidak ditemukan. Coba lagi.');
    }
    const target = groupList[idx];
    session._vcfGroupPickerList = null;
    vcfPending.set(userId, { waitingFile: true, groupId: target.id, groupName: target.subject });
    await ctx.editMessageText(`✅ Grup tujuan VCF dipilih!\n\n🎯 ${esc(target.subject)}\n👥 ${target.participants?.length || 0} anggota\n\n📎 Sekarang kirim file .vcf ke chat ini.`);
});

tgBot.action('vcf_add_all', async (ctx) => {
    const userId = ctx.from.id;
    if (!await canUseBot(userId)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();
    const pending = vcfPending.get(userId);
    if (!pending || !pending.contacts) return safeReply(ctx, '❌ Data tidak ditemukan.');
    await addContactsToGroup(ctx, userId, pending.contacts, pending.groupId, pending.groupName);
});

tgBot.action('vcf_cancel', async (ctx) => {
    vcfPending.delete(ctx.from.id);
    await ctx.answerCbQuery('Dibatalkan');
    await safeReply(ctx, '✖ Import dibatalkan.');
});

tgBot.action(/^toggle_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    if (!await canUseBot(userId)) return ctx.answerCbQuery('⛔ Ditolak.');
    const jid = ctx.match[1];
    const session = userSessions.get(userId);
    if (!session || !kickSelections.has(userId)) return ctx.answerCbQuery('Session expired.');
    const selected = kickSelections.get(userId);
    if (selected.has(jid)) {
        selected.delete(jid);
        await ctx.answerCbQuery('❌ Dihapus');
    } else {
        selected.add(jid);
        await ctx.answerCbQuery('✅ Ditambahkan');
    }
    try { await ctx.editMessageReplyMarkup(buildMemberKeyboard(session.members, selected).reply_markup); } catch (err) {}
});

tgBot.action('do_kick', async (ctx) => {
    const userId = ctx.from.id;
    if (!await canUseBot(userId)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();
    if (!isAdmin(userId) && !isActiveHours()) {
        return safeReply(ctx, `⚠️ Untuk keamanan akun WA, kick hanya bisa dilakukan jam 08.00 - 22.00 WIB.\n\n_Ini untuk menghindari deteksi otomatis dari WhatsApp._`);
    }
    const session = userSessions.get(userId);
    const selected = kickSelections.get(userId);
    if (!session || !session.loggedIn) return safeReply(ctx, '❌ Session expired.');
    if (!selected || selected.size === 0) return safeReply(ctx, '⚠️ Belum ada yang dipilih!');
    const jidList = Array.from(selected);
    const kickAnim = await liveKickProgress(ctx, jidList.length);
    const totalKicked = await burstThenPauseKick(session.sock, session.groupId, jidList, (progress) => { kickAnim.update(progress); });
    kickSelections.set(userId, new Set());
    await kickAnim.stop(`✅ Kick Selesai\\!\n\n🦵 ${totalKicked} dari ${jidList.length} anggota berhasil dikick\\.\n🎯 Grup: ${esc(session.groupName || 'N/A')}`);
});

tgBot.action('cancel_kick', async (ctx) => {
    kickSelections.set(ctx.from.id, new Set());
    await ctx.answerCbQuery('Dibatalkan');
    await safeReply(ctx, '✖ Kick dibatalkan.');
});

// ========== AUTO EXPIRE NOTIF ==========
setInterval(async () => {
    const users = await getAllUsers();
    const now = new Date();
    for (const u of users) {
        const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
        if (!exp) continue;
        const msLeft = new Date(exp) - now;
        if (msLeft > 0 && msLeft <= 24 * 60 * 60 * 1000 && !u.notifiedExpiry) {
            try {
                await tgBot.telegram.sendMessage(u.id, `⚠️ Akses akan habis dalam ${formatCountdown(exp)}\nPerpanjang: /beli`, { parse_mode: 'Markdown' });
                await db.updateNotifiedFlag(u.id);
            } catch (err) {
                log('WARN', 'Expiry', `Gagal kirim notif ke ${u.id}: ${err.message}`);
            }
        }
    }
}, 60 * 60 * 1000);

// ========== HEALTH CHECK (FIXED WITH AUTH) ==========
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    // Public endpoint untuk Railway healthcheck
    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
    }
    
    // Endpoint lama tetap pakai API key
    const apiKey = url.searchParams.get('key');
    if (apiKey !== HEALTH_API_KEY) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'ok',
        bot: 'WA Kicker Bot v5.1.0',
        uptime: Math.floor(process.uptime()) + 's',
        activeSessions: userSessions.size,
        timestamp: new Date().toISOString()
    }));
}).listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Health check aktif di port ${PORT}`);
});

// ========== LAUNCH ==========
tgBot.launch().then(() => {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║          W A - K I C K E R   B O T   v 5 . 1 . 0            ║');
    console.log('║        G O D M O D E   E D I T I O N   (FULL FIXED)         ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Admin IDs      : ${ADMIN_IDS.join(', ')}`);
    console.log(`║  Trial          : ${TRIAL_DURATION_HOURS} jam`);
    console.log(`║  Kick Limit     : ${KICK_LIMIT_PER_SESSION} per sesi`);
    console.log(`║  Database       : JSON (${DATA_DIR})`);
    console.log(`║  Session Cleanup: Auto (${SESSION_IDLE_MS / 3600000} jam idle)`);
    console.log(`║  Health Auth    : Enabled (API Key required)`);
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
});

process.on('SIGINT', () => { tgBot.stop('SIGINT'); process.exit(); });
process.on('SIGTERM', () => { tgBot.stop('SIGTERM'); process.exit(); });
process.on('uncaughtException', (err) => { log('ERROR', 'System', 'Uncaught Exception', err); });
process.on('unhandledRejection', (reason) => { log('ERROR', 'System', 'Unhandled Rejection', reason); });
