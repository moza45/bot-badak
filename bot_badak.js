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
const XLSX = require('xlsx');
// ╔══════════════════════════════════════════════════════════════╗
// ║         W A - K I C K E R   B O T   v 6 . 0 . 0            ║
// ║      F I L E   M A N A G E M E N T   E D I T I O N         ║
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
const HEALTH_API_KEY = process.env.HEALTH_API_KEY || crypto.randomBytes(16).toString('hex');
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '10');
const MAX_FILES_PER_BATCH = parseInt(process.env.MAX_FILES_PER_BATCH || '20');
const ADMIN_FILES_DIR = process.env.ADMIN_FILES_DIR || path.join(DATA_DIR || './data', 'admin_files');

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

// Buat direktori admin files
if (!fs.existsSync(ADMIN_FILES_DIR)) fs.mkdirSync(ADMIN_FILES_DIR, { recursive: true });

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
    const tmp = filePath + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(tmp, filePath);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        throw err;
    }
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

// ========== STATE MANAGEMENT TERPUSAT ==========
const userStates = new Map();

// Cleanup state yang expired (setiap 10 menit)
setInterval(() => {
    const now = Date.now();
    for (const [uid, state] of userStates.entries()) {
        if (state.expiresAt && now > state.expiresAt) {
            userStates.delete(uid);
        }
    }
}, 10 * 60 * 1000);

function setState(userId, data) {
    userStates.set(userId, { ...data, expiresAt: Date.now() + 10 * 60 * 1000 });
}

function getState(userId) {
    return userStates.get(userId) || null;
}

function clearState(userId) {
    userStates.delete(userId);
}

// ========== LOGGER ==========
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

// ========== SAFE REPLY ==========
async function safeReply(ctx, text, opts = {}) {
    const mdOpts = { parse_mode: 'Markdown', ...opts };
    try {
        return await ctx.reply(text, mdOpts);
    } catch (err) {
        if (err.message && (err.message.includes("parse entities") || err.message.includes("Bad Request"))) {
            const { parse_mode, ...safeOpts } = mdOpts;
            try {
                return await ctx.reply(text.replace(/[*_`[\]()~>#+=|{}.!\\-]/g, "\\$&"), { ...safeOpts });
            } catch (err2) {
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

// ========== SESSION CLEANUP ==========
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
    for (const [uid, entry] of rateLimitMap.entries()) {
        if (now > entry.resetAt + 60000) rateLimitMap.delete(uid);
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

function isPhoneNumber(val) {
    const str = String(val).replace(/[\s\-().]/g, '');
    return /^(\+?62|0)[0-9]{8,13}$/.test(str) || /^[0-9]{10,15}$/.test(str);
}

function safeFilename(name) {
    return name.replace(/[\/\\:*?"<>|]/g, '_').substring(0, 100);
}

const DIVIDER = '━━━━━━━━━━━━━━━━━━━━━━';
const DIVIDER_THIN = '┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄';

// ========== UTILITAS FILE BARU ==========
async function downloadTelegramFile(ctx, fileId) {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const resp = await fetch(fileLink.href);
    return Buffer.from(await resp.arrayBuffer());
}

async function sendFile(ctx, buffer, filename, caption = '') {
    await ctx.replyWithDocument(
        { source: buffer, filename },
        caption ? { caption } : {}
    );
}

function generateVCF(contacts) {
    const seen = new Set();
    const uniqueContacts = [];
    for (const { name, phone } of contacts) {
        const norm = normalizePhone(phone);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        uniqueContacts.push({ name: name || `Kontak ${phone}`, phone: norm });
    }
    
    return uniqueContacts.map(({ name, phone }) =>
        `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;TYPE=CELL:+${phone}\nEND:VCARD`
    ).join('\n');
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

function autoDetectAndParse(line) {
    line = line.trim();
    if (!line) return null;
    
    // Cek apakah baris diawali nomor (format Navy)
    const navyMatch = line.match(/^(\+?[0-9]{10,15})\s+(.+)$/);
    if (navyMatch) return { phone: navyMatch[1], name: navyMatch[2].trim() };
    
    // Cek format nama|nomor atau nama,nomor
    const sepMatch = line.match(/^(.+?)[,|]\s*(\+?[0-9]{8,15})$/);
    if (sepMatch) return { phone: sepMatch[2], name: sepMatch[1].trim() };
    
    // Cek format nomor|nama atau nomor,nama
    const sepMatch2 = line.match(/^(\+?[0-9]{8,15})[,|]\s*(.+)$/);
    if (sepMatch2) return { phone: sepMatch2[1], name: sepMatch2[2].trim() };
    
    // Cek hanya nomor
    const phoneOnly = line.match(/^(\+?[0-9]{10,15})$/);
    if (phoneOnly) return { phone: phoneOnly[1], name: `Kontak ${phoneOnly[1]}` };
    
    // Cek tab-separated
    const tabMatch = line.match(/^(.+?)\t(\+?[0-9]{8,15})$/);
    if (tabMatch) {
        const a = tabMatch[1].trim();
        const b = tabMatch[2].trim();
        if (/^\+?[0-9]{10,15}$/.test(a.replace(/[\s\-().]/g, ''))) {
            return { phone: a, name: b };
        }
        return { phone: b, name: a };
    }
    
    return null;
}

function parseTxtLines(text) {
    const lines = text.split(/\r?\n/);
    const contacts = [];
    const seen = new Set();
    for (const line of lines) {
        const parsed = autoDetectAndParse(line);
        if (!parsed) continue;
        const norm = normalizePhone(parsed.phone);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        contacts.push({ name: parsed.name || `Kontak ${norm}`, phone: norm });
    }
    return contacts;
}

// ========== MIDDLEWARE ==========
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

// ========== KEYBOARDS ==========
const KB_LANDING = {
    reply_markup: {
        keyboard: [[{ text: '🎁 Coba Gratis (Trial)' }, { text: '⭐ Premium' }], [{ text: '❓ Bantuan' }]],
        resize_keyboard: true, one_time_keyboard: false
    }
};
const KB_PRE_LOGIN = {
    reply_markup: {
        keyboard: [[{ text: '🔑 Login WhatsApp' }], [{ text: '📊 Status' }, { text: '👤 Akun Saya' }], [{ text: '⭐ Premium' }, { text: '❓ Bantuan' }], [{ text: '🔧 File Tools' }]],
        resize_keyboard: true, one_time_keyboard: false
    }
};
const KB_MAIN = {
    reply_markup: {
        keyboard: [[{ text: '📋 Daftar Grup' }, { text: '🎯 Pilih Grup' }], [{ text: '➕ Buat Grup WA' }, { text: '📥 Import VCF' }], [{ text: '🔴 Kick Menu' }, { text: '📡 Status' }], [{ text: '🔧 File Tools' }, { text: '🚪 Logout WhatsApp' }]],
        resize_keyboard: true, one_time_keyboard: false
    }
};
const KB_ADMIN_PRE = {
    reply_markup: {
        keyboard: [[{ text: '🔑 Login WhatsApp' }], [{ text: '📋 Pending Payment' }, { text: '👥 User List' }], [{ text: '📊 Status' }, { text: '❓ Bantuan' }], [{ text: '🔧 File Tools' }], [{ text: '📁 Admin File Manager' }]],
        resize_keyboard: true, one_time_keyboard: false
    }
};
const KB_ADMIN_MAIN = {
    reply_markup: {
        keyboard: [[{ text: '📋 Daftar Grup' }, { text: '🎯 Pilih Grup' }], [{ text: '➕ Buat Grup WA' }, { text: '📥 Import VCF' }], [{ text: '🔴 Kick Menu' }, { text: '📡 Status' }], [{ text: '🔧 File Tools' }, { text: '📁 Admin File Manager' }], [{ text: '📋 Pending Payment' }, { text: '👥 User List' }], [{ text: '🚪 Logout WhatsApp' }]],
        resize_keyboard: true, one_time_keyboard: false
    }
};
const KB_FILE_TOOLS = {
    reply_markup: {
        keyboard: [
            [{ text: '🔄 TXT → VCF' }, { text: '🔄 VCF → TXT' }],
            [{ text: '📊 XLSX → VCF' }, { text: '📝 TXT2VCF Auto' }],
            [{ text: '🔗 Gabung TXT' }, { text: '🔗 Gabung VCF' }],
            [{ text: '✂️ Pecah VCF' }, { text: '✂️ Pecah VCF (jlh)' }],
            [{ text: '➕ Tambah Kontak' }, { text: '➖ Hapus Kontak' }],
            [{ text: '🔢 Hitung Kontak' }, { text: '✏️ Rename Kontak' }],
            [{ text: '📋 List Grup WA' }, { text: '📸 Rekap Grup' }],
            [{ text: '📄 Pesan ke TXT' }, { text: '📝 Rename File' }],
            [{ text: '↩️ Kembali' }]
        ],
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

// ========== HUMAN DELAY FUNCTIONS ==========
async function humanDelay(minMs = 1200, maxMs = 3800) {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1) + minMs);
    return new Promise(resolve => setTimeout(resolve, delay));
}

function gaussianRandom(mean, std) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return mean + std * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

function getSessionMood() {
    const r = Math.random();
    if (r < 0.50) return 'normal';
    if (r < 0.75) return 'cepat';
    if (r < 0.90) return 'pelan';
    return 'distracted';
}

async function humanDelayKick(mood) {
    let base, std;
    switch (mood) {
        case 'cepat':      base = 18;  std = 4;   break;
        case 'pelan':      base = 45;  std = 10;  break;
        case 'distracted': base = 70;  std = 25;  break;
        default:           base = 30;  std = 8;   break;
    }
    if (Math.random() < 0.15) base += 20 + Math.random() * 30;
    const delaySec = clamp(gaussianRandom(base, std), 10, 120);
    log('INFO', 'HumanDelay', `Jeda kick [${mood}]: ${Math.round(delaySec)} detik`);
    return new Promise(r => setTimeout(r, Math.floor(delaySec * 1000)));
}

async function humanDelayAdd(mood) {
    let base, std;
    switch (mood) {
        case 'cepat':      base = 35;  std = 8;   break;
        case 'pelan':      base = 75;  std = 15;  break;
        case 'distracted': base = 110; std = 30;  break;
        default:           base = 55;  std = 12;  break;
    }
    if (Math.random() < 0.20) base += 30 + Math.random() * 60;
    const delaySec = clamp(gaussianRandom(base, std), 25, 240);
    log('INFO', 'HumanDelay', `Jeda add [${mood}]: ${Math.round(delaySec)} detik`);
    return new Promise(r => setTimeout(r, Math.floor(delaySec * 1000)));
}

async function humanDelayLongBreak(label = 'break') {
    let delaySec;
    if (Math.random() < 0.6) {
        delaySec = clamp(gaussianRandom(180, 40), 90, 260);
    } else {
        delaySec = clamp(gaussianRandom(450, 90), 280, 720);
    }
    log('INFO', 'HumanDelay', `Long break [${label}]: ${Math.round(delaySec / 60, 1)} menit`);
    return new Promise(r => setTimeout(r, Math.floor(delaySec * 1000)));
}

async function humanDelayError() {
    const delaySec = clamp(gaussianRandom(300, 80), 180, 600);
    log('INFO', 'HumanDelay', `Jeda error: ${Math.round(delaySec)} detik`);
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

// ========== BACKGROUND ACTIVITY SPOOFER ==========
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
            // Abaikan error edit message
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

// ========== VCF HANDLERS ==========
async function showGroupPicker(ctx, userId, session) {
    touchSession(userId);
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

// ========== FILE HANDLERS FITUR BARU ==========

// 1. /rekapgroup - Rekap Info Grup dari Foto
async function handleRekapGroup(ctx, userId) {
    setState(userId, { mode: 'rekapgroup', phase: 'waiting_photo' });
    await safeReply(ctx, `📸 *Rekap Grup*\n\nSilakan kirim foto/screenshot info grup WhatsApp.\nAtau kirim foto dengan caption format:\n\`NamaGrup|JumlahMember\`\n\nContoh caption: \`Arisan RT 05|150\``);
}

async function handleRekapGroupPhoto(ctx, userId, state) {
    const photo = ctx.message.photo;
    if (!photo || photo.length === 0) {
        return safeReply(ctx, '❌ Tidak ada foto yang terdeteksi. Silakan kirim foto info grup.');
    }
    
    const caption = ctx.message.caption || '';
    const captionMatch = caption.match(/^(.+?)\|(\d+)$/);
    
    if (captionMatch) {
        const groupName = captionMatch[1].trim();
        const memberCount = captionMatch[2];
        const rekapText = `📸 REKAP GRUP\n${DIVIDER}\n📋 Nama Grup : ${groupName}\n👥 Jumlah Member : ${memberCount}\n📅 Di-rekap : ${formatDate(new Date().toISOString())}\n${DIVIDER}`;
        clearState(userId);
        return safeReply(ctx, rekapText);
    }
    
    // Jika tidak ada caption, simpan foto dan beri panduan
    await safeReply(ctx, `📸 Foto diterima!\n\nBot tidak bisa membaca teks dari gambar secara otomatis.\nSilakan kirim ulang foto dengan caption format:\n\`NamaGrup|JumlahMember\`\n\nAtau ketik manual:\n\`NamaGrup|JumlahMember\``);
}

// 2. /cv_txt_to_vcf - Convert Multiple TXT ke Multiple VCF
async function handleCvTxtToVcfStart(ctx, userId) {
    setState(userId, { mode: 'cv_txt_to_vcf', files: [], collecting: true });
    await safeReply(ctx, `🔄 *TXT → VCF (Multiple)*\n\nSilakan kirim file .txt satu per satu.\nSetiap file akan dikonversi menjadi file .vcf terpisah.\n\nKetik /done jika sudah selesai.`);
}

async function handleCvTxtToVcfFile(ctx, userId, state) {
    const doc = ctx.message.document;
    const fname = doc.file_name || 'file.txt';
    
    if (!fname.toLowerCase().endsWith('.txt')) {
        return safeReply(ctx, '⚠️ Hanya file .txt yang diterima.');
    }
    
    if (doc.file_size && doc.file_size > MAX_FILE_SIZE_MB * 1024 * 1024) {
        return safeReply(ctx, `❌ File terlalu besar. Maks ${MAX_FILE_SIZE_MB}MB.`);
    }
    
    if (state.files.length >= MAX_FILES_PER_BATCH) {
        return safeReply(ctx, `❌ Maksimal ${MAX_FILES_PER_BATCH} file per batch.`);
    }
    
    try {
        const buffer = await downloadTelegramFile(ctx, doc.file_id);
        const textContent = buffer.toString('utf-8');
        state.files.push({ name: fname, content: textContent });
        setState(userId, state);
        await safeReply(ctx, `✅ File ke-${state.files.length}: ${fname} diterima.\n\nKetik /done untuk proses semua.`);
    } catch (err) {
        log('ERROR', 'CvTxtToVcf', err.message, err);
        await safeReply(ctx, `❌ Error membaca file: ${esc(err.message)}`);
    }
}

async function finalizeCvTxtToVcf(ctx, userId, state) {
    if (state.files.length === 0) {
        clearState(userId);
        return safeReply(ctx, '❌ Tidak ada file yang dikumpulkan.');
    }
    
    try {
        let totalContacts = 0;
        let totalDuplicates = 0;
        let results = [];
        
        for (const file of state.files) {
            const contacts = parseTxtLines(file.content);
            const baseName = file.name.replace(/\.txt$/i, '');
            const vcfContent = generateVCF(contacts);
            const vcfBuffer = Buffer.from(vcfContent, 'utf-8');
            const vcfFileName = `${baseName}.vcf`;
            
            // Hitung duplikat
            const allLines = file.content.split(/\r?\n/);
            const seen = new Set();
            const validCount = contacts.length;
            let dupCount = 0;
            for (const line of allLines) {
                const parsed = autoDetectAndParse(line);
                if (!parsed) continue;
                const norm = normalizePhone(parsed.phone);
                if (!norm) continue;
                if (seen.has(norm)) dupCount++;
                seen.add(norm);
            }
            
            await sendFile(ctx, vcfBuffer, vcfFileName, `✅ ${file.name} → ${vcfFileName} (${validCount} kontak, ${dupCount} duplikat)`);
            results.push(`✅ ${file.name} → ${vcfFileName} (${validCount} kontak, ${dupCount} duplikat dihapus)`);
            totalContacts += validCount;
            totalDuplicates += dupCount;
        }
        
        const summary = `📦 *HASIL KONVERSI*\n\n${results.join('\n')}\n\n📊 Total: ${state.files.length} file\n👤 Total kontak unik: ${totalContacts}\n🚫 Total duplikat: ${totalDuplicates}`;
        await safeReply(ctx, summary);
    } catch (err) {
        log('ERROR', 'CvTxtToVcf', err.message, err);
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
    } finally {
        clearState(userId);
    }
}

// 3. /cv_vcf_to_txt - Convert Multiple VCF ke Multiple TXT
async function handleCvVcfToTxtStart(ctx, userId) {
    setState(userId, { mode: 'cv_vcf_to_txt', files: [], collecting: true });
    await safeReply(ctx, `🔄 *VCF → TXT (Multiple)*\n\nSilakan kirim file .vcf satu per satu.\nSetiap file akan dikonversi menjadi file .txt terpisah.\n\nKetik /done jika sudah selesai.`);
}

async function handleCvVcfToTxtFile(ctx, userId, state) {
    const doc = ctx.message.document;
    const fname = doc.file_name || 'file.vcf';
    
    if (!fname.toLowerCase().endsWith('.vcf')) {
        return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    }
    
    if (doc.file_size && doc.file_size > MAX_FILE_SIZE_MB * 1024 * 1024) {
        return safeReply(ctx, `❌ File terlalu besar. Maks ${MAX_FILE_SIZE_MB}MB.`);
    }
    
    if (state.files.length >= MAX_FILES_PER_BATCH) {
        return safeReply(ctx, `❌ Maksimal ${MAX_FILES_PER_BATCH} file per batch.`);
    }
    
    try {
        const buffer = await downloadTelegramFile(ctx, doc.file_id);
        const vcfText = buffer.toString('utf-8');
        state.files.push({ name: fname, content: vcfText });
        setState(userId, state);
        await safeReply(ctx, `✅ File ke-${state.files.length}: ${fname} diterima.\n\nKetik /done untuk proses semua.`);
    } catch (err) {
        log('ERROR', 'CvVcfToTxt', err.message, err);
        await safeReply(ctx, `❌ Error membaca file: ${esc(err.message)}`);
    }
}

async function finalizeCvVcfToTxt(ctx, userId, state) {
    if (state.files.length === 0) {
        clearState(userId);
        return safeReply(ctx, '❌ Tidak ada file yang dikumpulkan.');
    }
    
    try {
        let results = [];
        
        for (const file of state.files) {
            const contacts = parseVCF(file.content);
            const baseName = file.name.replace(/\.vcf$/i, '');
            const txtContent = contacts.map(c => c.phone).join('\n');
            const txtBuffer = Buffer.from(txtContent, 'utf-8');
            const txtFileName = `${baseName}.txt`;
            
            await sendFile(ctx, txtBuffer, txtFileName, `✅ ${file.name} → ${txtFileName} (${contacts.length} nomor unik)`);
            results.push(`✅ ${file.name} → ${txtFileName} (${contacts.length} nomor unik)`);
        }
        
        const summary = `📦 *HASIL KONVERSI*\n\n${results.join('\n')}\n\n📊 Total: ${state.files.length} file diproses`;
        await safeReply(ctx, summary);
    } catch (err) {
        log('ERROR', 'CvVcfToTxt', err.message, err);
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
    } finally {
        clearState(userId);
    }
}

// 4. /cv_xlsx_to_vcf - Convert XLSX ke VCF
async function handleCvXlsxToVcfStart(ctx, userId) {
    setState(userId, { mode: 'cv_xlsx_to_vcf', waiting: true });
    await safeReply(ctx, `📊 *XLSX → VCF*\n\nSilakan kirim file .xlsx.\nBot akan memindai semua cell dan mengambil nomor telepon yang valid.`);
}

async function handleCvXlsxToVcfFile(ctx, userId, state) {
    const doc = ctx.message.document;
    const fname = doc.file_name || 'file.xlsx';
    
    if (!fname.toLowerCase().endsWith('.xlsx')) {
        return safeReply(ctx, '⚠️ Hanya file .xlsx yang diterima.');
    }
    
    if (doc.file_size && doc.file_size > MAX_FILE_SIZE_MB * 1024 * 1024) {
        return safeReply(ctx, `❌ File terlalu besar. Maks ${MAX_FILE_SIZE_MB}MB.`);
    }
    
    try {
        const buffer = await downloadTelegramFile(ctx, doc.file_id);
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        
        let allNumbers = [];
        let totalCells = 0;
        
        for (const sheetName of workbook.SheetNames) {
            const sheet = workbook.Sheets[sheetName];
            const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
            for (const row of data) {
                if (!row) continue;
                for (const cell of row) {
                    totalCells++;
                    if (cell !== null && cell !== undefined && isPhoneNumber(cell)) {
                        const norm = normalizePhone(String(cell));
                        if (norm) allNumbers.push(norm);
                    }
                }
            }
        }
        
        // Hapus duplikat
        const seen = new Set();
        const uniqueNumbers = [];
        let dupCount = 0;
        for (const num of allNumbers) {
            if (seen.has(num)) {
                dupCount++;
                continue;
            }
            seen.add(num);
            uniqueNumbers.push(num);
        }
        
        const contacts = uniqueNumbers.map(num => ({ name: `Kontak ${num}`, phone: num }));
        const vcfContent = generateVCF(contacts);
        const baseName = fname.replace(/\.xlsx$/i, '');
        const vcfBuffer = Buffer.from(vcfContent, 'utf-8');
        
        const infoText = `📊 HASIL KONVERSI XLSX → VCF\n${DIVIDER}\n📋 File : ${fname}\n🔢 Total cell dipindai : ${totalCells}\n📞 Nomor ditemukan : ${allNumbers.length}\n🚫 Duplikat dihapus : ${dupCount}\n✅ Kontak unik : ${uniqueNumbers.length}\n${DIVIDER}`;
        
        await sendFile(ctx, vcfBuffer, `${baseName}.vcf`, infoText);
        clearState(userId);
    } catch (err) {
        log('ERROR', 'CvXlsxToVcf', err.message, err);
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
        clearState(userId);
    }
}

// 5. /txt2vcf - Convert TXT ke VCF Auto-Detect
async function handleTxt2VcfStart(ctx, userId) {
    setState(userId, { mode: 'txt2vcf', waiting: true });
    await safeReply(ctx, `📝 *TXT2VCF Auto-Detect*\n\nKirim file .txt untuk langsung dikonversi menjadi VCF.\n\nFormat yang didukung:\n• Nomor di depan: \`08123 Nama\`\n• Nama di depan: \`Nama 08123\`\n• Separator: \`Nama|08123\` atau \`Nama,08123\`\n• Hanya nomor: \`081234567890\``);
}

async function handleTxt2VcfFile(ctx, userId, state) {
    const doc = ctx.message.document;
    const fname = doc.file_name || 'file.txt';
    
    if (!fname.toLowerCase().endsWith('.txt')) {
        return safeReply(ctx, '⚠️ Hanya file .txt yang diterima.');
    }
    
    if (doc.file_size && doc.file_size > MAX_FILE_SIZE_MB * 1024 * 1024) {
        return safeReply(ctx, `❌ File terlalu besar. Maks ${MAX_FILE_SIZE_MB}MB.`);
    }
    
    try {
        const buffer = await downloadTelegramFile(ctx, doc.file_id);
        const textContent = buffer.toString('utf-8');
        const contacts = parseTxtLines(textContent);
        
        if (contacts.length === 0) {
            return safeReply(ctx, '❌ Tidak ada nomor telepon valid yang ditemukan.');
        }
        
        const baseName = fname.replace(/\.txt$/i, '');
        const vcfContent = generateVCF(contacts);
        const vcfBuffer = Buffer.from(vcfContent, 'utf-8');
        
        // Hitung duplikat
        const lines = textContent.split(/\r?\n/);
        const seen = new Set();
        let dupCount = 0;
        for (const line of lines) {
            const parsed = autoDetectAndParse(line);
            if (!parsed) continue;
            const norm = normalizePhone(parsed.phone);
            if (!norm) continue;
            if (seen.has(norm)) dupCount++;
            seen.add(norm);
        }
        
        await sendFile(ctx, vcfBuffer, `${baseName}.vcf`, `✅ ${fname} → ${baseName}.vcf\n👤 ${contacts.length} kontak unik\n🚫 ${dupCount} duplikat dihapus`);
        clearState(userId);
    } catch (err) {
        log('ERROR', 'Txt2Vcf', err.message, err);
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
        clearState(userId);
    }
}

// 6. /cvadminfile - Kelola File Admin
async function handleCvAdminFile(ctx, userId) {
    if (!isAdmin(userId)) {
        return safeReply(ctx, '⛔ Akses ditolak. Hanya admin yang bisa mengakses fitur ini.');
    }
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📤 Upload File', 'adminfile_upload')],
        [Markup.button.callback('📂 Lihat File', 'adminfile_list')],
        [Markup.button.callback('🗑️ Hapus File', 'adminfile_delete')],
        [Markup.button.callback('📥 Download File', 'adminfile_download')],
    ]);
    
    await safeReply(ctx, `📁 *ADMIN FILE MANAGER*\n\nPilih aksi yang diinginkan:`, { ...keyboard });
}

async function handleAdminFileUpload(ctx, userId) {
    if (!isAdmin(userId)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();
    setState(userId, { mode: 'cvadminfile_upload', waiting: true });
    await safeReply(ctx, `📤 Silakan kirim file yang ingin diupload ke admin storage.`);
}

async function handleAdminFileUploadFile(ctx, userId, state) {
    const doc = ctx.message.document;
    const fname = safeFilename(doc.file_name || 'unnamed_file');
    
    try {
        const buffer = await downloadTelegramFile(ctx, doc.file_id);
        const filePath = path.join(ADMIN_FILES_DIR, fname);
        
        // Cek jika file sudah ada
        if (fs.existsSync(filePath)) {
            const baseName = path.parse(fname).name;
            const ext = path.parse(fname).ext;
            const newName = `${baseName}_${Date.now()}${ext}`;
            fs.writeFileSync(path.join(ADMIN_FILES_DIR, newName), buffer);
            await safeReply(ctx, `✅ File diupload sebagai: ${newName}\n\n(Nama asli: ${fname} sudah ada, jadi diganti)`);
        } else {
            fs.writeFileSync(filePath, buffer);
            await safeReply(ctx, `✅ File berhasil diupload: ${fname}`);
        }
        clearState(userId);
    } catch (err) {
        log('ERROR', 'AdminFile', err.message, err);
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
        clearState(userId);
    }
}

async function handleAdminFileList(ctx, userId) {
    if (!isAdmin(userId)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();
    
    try {
        const files = fs.readdirSync(ADMIN_FILES_DIR);
        if (files.length === 0) {
            return safeReply(ctx, '📂 Direktori admin kosong.');
        }
        
        let fileList = `📂 *DAFTAR FILE ADMIN*\n${DIVIDER}\n`;
        const fileInfo = files.map(f => {
            const filePath = path.join(ADMIN_FILES_DIR, f);
            const stats = fs.statSync(filePath);
            const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
            const mtime = new Date(stats.mtime).toLocaleString('id-ID');
            return { name: f, size: sizeMB, mtime };
        });
        
        fileInfo.sort((a, b) => b.mtime.localeCompare(a.mtime));
        
        fileInfo.forEach((f, i) => {
            fileList += `${i + 1}. ${esc(f.name)}\n   📏 ${f.size} MB | 📅 ${f.mtime}\n\n`;
        });
        
        fileList += `${DIVIDER}\nTotal: ${files.length} file`;
        
        // Jika terlalu panjang, kirim sebagai file
        if (fileList.length > 4000) {
            const txtBuffer = Buffer.from(fileList.replace(/[*_`[\]()~>#+=|{}.!\\-]/g, ''), 'utf-8');
            await sendFile(ctx, txtBuffer, 'admin_files_list.txt', '📂 Daftar file admin (format TXT)');
        } else {
            await safeReply(ctx, fileList);
        }
    } catch (err) {
        log('ERROR', 'AdminFile', err.message, err);
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
    }
}

async function handleAdminFileDelete(ctx, userId) {
    if (!isAdmin(userId)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();
    
    try {
        const files = fs.readdirSync(ADMIN_FILES_DIR);
        if (files.length === 0) {
            return safeReply(ctx, '📂 Tidak ada file yang bisa dihapus.');
        }
        
        const buttons = files.map((f, i) => {
            return [Markup.button.callback(`🗑️ ${f.substring(0, 30)}`, `adminfiledel_${i}`)];
        });
        buttons.push([Markup.button.callback('❌ Batal', 'adminfiledel_cancel')]);
        
        setState(userId, { mode: 'cvadminfile_delete', fileList: files });
        await safeReply(ctx, `🗑️ *HAPUS FILE ADMIN*\n\nPilih file yang ingin dihapus:`, { reply_markup: { inline_keyboard: buttons } });
    } catch (err) {
        log('ERROR', 'AdminFile', err.message, err);
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
    }
}

async function handleAdminFileDownload(ctx, userId) {
    if (!isAdmin(userId)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();
    
    try {
        const files = fs.readdirSync(ADMIN_FILES_DIR);
        if (files.length === 0) {
            return safeReply(ctx, '📂 Tidak ada file yang bisa diunduh.');
        }
        
        const buttons = files.map((f, i) => {
            return [Markup.button.callback(`📥 ${f.substring(0, 30)}`, `adminfiledl_${i}`)];
        });
        buttons.push([Markup.button.callback('❌ Batal', 'adminfiledl_cancel')]);
        
        setState(userId, { mode: 'cvadminfile_download', fileList: files });
        await safeReply(ctx, `📥 *DOWNLOAD FILE ADMIN*\n\nPilih file yang ingin diunduh:`, { reply_markup: { inline_keyboard: buttons } });
    } catch (err) {
        log('ERROR', 'AdminFile', err.message, err);
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
    }
}

// 7. /renamectc - Ganti Nama Kontak dalam File VCF
async function handleRenamectcStart(ctx, userId) {
    setState(userId, { mode: 'renamectc', phase: 'waiting_vcf' });
    await safeReply(ctx, `✏️ *RENAME KONTAK VCF*\n\nSilakan kirim file .vcf yang ingin direname kontaknya.`);
}

async function handleRenamectcFile(ctx, userId, state) {
    const doc = ctx.message.document;
    const fname = doc.file_name || 'file.vcf';
    
    if (!fname.toLowerCase().endsWith('.vcf')) {
        return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    }
    
    try {
        const buffer = await downloadTelegramFile(ctx, doc.file_id);
        const vcfText = buffer.toString('utf-8');
        const contacts = parseVCF(vcfText);
        
        if (contacts.length === 0) {
            return safeReply(ctx, '❌ Tidak ada kontak valid dalam file.');
        }
        
        // Tampilkan preview 5 kontak pertama
        let preview = `📋 *PREVIEW KONTAK*\n${DIVIDER}\n`;
        contacts.slice(0, 5).forEach((c, i) => {
            preview += `${i + 1}. ${c.name} → ${c.phone}\n`;
        });
        preview += `${DIVIDER}\nTotal: ${contacts.length} kontak\n\nPilih metode rename:`;
        
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('➕ Tambah Prefix', 'rename_prefix')],
            [Markup.button.callback('➕ Tambah Suffix', 'rename_suffix')],
            [Markup.button.callback('🔢 Ganti + Nomor Urut', 'rename_numbered')],
            [Markup.button.callback('❌ Batal', 'rename_cancel')],
        ]);
        
        setState(userId, { ...state, phase: 'choose_method', contacts, fileName: fname });
        await safeReply(ctx, preview, { ...keyboard });
    } catch (err) {
        log('ERROR', 'Renamectc', err.message, err);
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
        clearState(userId);
    }
}

// 8. /renamefile - Ganti Nama File yang Di-upload
async function handleRenameFileStart(ctx, userId, newName) {
    if (!newName || newName.trim().length === 0) {
        return safeReply(ctx, `Format: /renamefile [nama_baru]\n\nContoh: /renamefile arisan_baru`);
    }
    
    // Validasi nama
    const invalidChars = /[\/\\:*?"<>|]/;
    if (invalidChars.test(newName)) {
        return safeReply(ctx, `❌ Nama file tidak boleh mengandung karakter: / \\ : * ? " < > |`);
    }
    
    if (newName.length > 100) {
        return safeReply(ctx, `❌ Nama file maksimal 100 karakter.`);
    }
    
    const trimmedName = newName.trim();
    setState(userId, { mode: 'renamefile', newName: trimmedName, waiting: true });
    await safeReply(ctx, `✏️ *RENAME FILE*\n\nSilakan kirim file yang ingin diganti namanya.\nNama baru: \`${esc(trimmedName)}\` (ekstensi akan dipertahankan)`);
}

async function handleRenameFile(ctx, userId, state) {
    const doc = ctx.message.document;
    const fname = doc.file_name || 'file';
    const ext = path.extname(fname) || '';
    const newFileName = `${state.newName}${ext}`;
    
    try {
        const buffer = await downloadTelegramFile(ctx, doc.file_id);
        await sendFile(ctx, buffer, safeFilename(newFileName), `✅ File: ${esc(fname)}\n→ ${esc(newFileName)}`);
        clearState(userId);
    } catch (err) {
        log('ERROR', 'RenameFile', err.message, err);
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
        clearState(userId);
    }
}

// 9. /gabungtxt - Gabung Multiple TXT jadi Satu
async function handleGabungTxtStart(ctx, userId) {
    setState(userId, { mode: 'gabungtxt', files: [], collecting: true });
    await safeReply(ctx, `🔗 *GABUNG TXT*\n\nSilakan kirim file .txt satu per satu (minimal 2).\nSemua file akan digabung menjadi satu file .txt.\n\nKetik /done jika sudah selesai.`);
}

async function handleGabungTxtFile(ctx, userId, state) {
    const doc = ctx.message.document;
    const fname = doc.file_name || 'file.txt';
    
    if (!fname.toLowerCase().endsWith('.txt')) {
        return safeReply(ctx, '⚠️ Hanya file .txt yang diterima.');
    }
    
    if (doc.file_size && doc.file_size > MAX_FILE_SIZE_MB * 1024 * 1024) {
        return safeReply(ctx, `❌ File terlalu besar. Maks ${MAX_FILE_SIZE_MB}MB.`);
    }
    
    try {
        const buffer = await downloadTelegramFile(ctx, doc.file_id);
        const textContent = buffer.toString('utf-8');
        state.files.push({ name: fname, content: textContent });
        setState(userId, state);
        await safeReply(ctx, `✅ File ke-${state.files.length}: ${fname} diterima.\n\nKetik /done untuk gabungkan semua.`);
    } catch (err) {
        log('ERROR', 'GabungTxt', err.message, err);
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
    }
}

async function finalizeGabungTxt(ctx, userId, state) {
    if (state.files.length < 2) {
        clearState(userId);
        return safeReply(ctx, '❌ Minimal 2 file untuk digabung.');
    }
    
    try {
        const allLines = [];
        let totalLines = 0;
        
        for (const file of state.files) {
            const lines = file.content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            totalLines += lines.length;
            allLines.push(...lines);
        }
        
        // Hapus duplikat
        const seenLines = new Set();
        const merged = [];
        for (const line of allLines) {
            const normalized = normalizePhone(line) || line.toLowerCase();
            if (!normalized || seenLines.has(normalized)) continue;
            seenLines.add(normalized);
            merged.push(line);
        }
        
        const dupCount = allLines.length - merged.length;
        const txtContent = merged.join('\n');
        const txtBuffer = Buffer.from(txtContent, 'utf-8');
        
        const filesJoined = state.files.map(f => f.name).join(', ');
        const infoText = `📄 HASIL GABUNG TXT\n${DIVIDER}\n📁 File digabung : ${state.files.length} file\n📁 Nama file : ${filesJoined.substring(0, 200)}\n📝 Total baris masuk : ${totalLines}\n🚫 Duplikat dihapus : ${dupCount}\n✅ Baris unik : ${merged.length}\n${DIVIDER}`;
        
        await sendFile(ctx, txtBuffer, 'gabungan.txt', infoText);
        clearState(userId);
    } catch (err) {
        log('ERROR', 'GabungTxt', err.message, err);
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
        clearState(userId);
    }
}

// 10. /gabungvcf - Gabung Multiple VCF jadi Satu
async function handleGabungVcfStart(ctx, userId) {
    setState(userId, { mode: 'gabungvcf', files: [], collecting: true });
    await safeReply(ctx, `🔗 *GABUNG VCF*\n\nSilakan kirim file .vcf satu per satu (minimal 2).\nSemua file akan digabung menjadi satu file .vcf.\n\nKetik /done jika sudah selesai.`);
}

async function handleGabungVcfFile(ctx, userId, state) {
    const doc = ctx.message.document;
    const fname = doc.file_name || 'file.vcf';
    
    if (!fname.toLowerCase().endsWith('.vcf')) {
        return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    }
    
    if (doc.file_size && doc.file_size > MAX_FILE_SIZE_MB * 1024 * 1024) {
        return safeReply(ctx, `❌ File terlalu besar. Maks ${MAX_FILE_SIZE_MB}MB.`);
    }
    
    try {
        const buffer = await downloadTelegramFile(ctx, doc.file_id);
        const vcfText = buffer.toString('utf-8');
        state.files.push({ name: fname, content: vcfText });
        setState(userId, state);
        await safeReply(ctx, `✅ File ke-${state.files.length}: ${fname} diterima.\n\nKetik /done untuk gabungkan semua.`);
    } catch (err) {
        log('ERROR', 'GabungVcf', err.message, err);
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
    }
}

async function finalizeGabungVcf(ctx, userId, state) {
    if (state.files.length < 2) {
        clearState(userId);
        return safeReply(ctx, '❌ Minimal 2 file untuk digabung.');
    }
    
    try {
        const allContacts = [];
        const seen = new Set();
        let totalContacts = 0;
        let dupCount = 0;
        
        for (const file of state.files) {
            const contacts = parseVCF(file.content);
            totalContacts += contacts.length;
            for (const c of contacts) {
                const norm = normalizePhone(c.phone);
                if (!norm) continue;
                if (seen.has(norm)) {
                    dupCount++;
                    continue;
                }
                seen.add(norm);
                allContacts.push(c);
            }
        }
        
        const vcfContent = generateVCF(allContacts);
        const vcfBuffer = Buffer.from(vcfContent, 'utf-8');
        
        const filesJoined = state.files.map(f => f.name).join(', ');
        const infoText = `📄 HASIL GABUNG VCF\n${DIVIDER}\n📁 File digabung : ${state.files.length} file\n📁 Nama file : ${filesJoined.substring(0, 200)}\n📝 Total kontak masuk : ${totalContacts}\n🚫 Duplikat dihapus : ${dupCount}\n✅ Kontak unik : ${allContacts.length}\n${DIVIDER}`;
        
        await sendFile(ctx, vcfBuffer, 'gabungan.vcf', infoText);
        clearState(userId);
    } catch (err) {
        log('ERROR', 'GabungVcf', err.message, err);
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
        clearState(userId);
    }
}

// 11. /pecahfile - Pecah VCF Jadi Beberapa Bagian
async function handlePecahFileStart(ctx, userId) {
    setState(userId, { mode: 'pecahfile', phase: 'waiting_vcf' });
    await safeReply(ctx, `✂️ *PECAH VCF (BAGIAN)*\n\nSilakan kirim file .vcf yang ingin dipecah.`);
}

async function handlePecahFileVcf(ctx, userId, state) {
    const doc = ctx.message.document;
    const fname = doc.file_name || 'file.vcf';
    
    if (!fname.toLowerCase().endsWith('.vcf')) {
        return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    }
    
    try {
        const buffer = await downloadTelegramFile(ctx, doc.file_id);
        const vcfText = buffer.toString('utf-8');
        const contacts = parseVCF(vcfText);
        
        if (contacts.length < 2) {
            return safeReply(ctx, '❌ Minimal 2 kontak untuk dipecah.');
        }
        
        const baseName = fname.replace(/\.vcf$/i, '');
        
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✂️ 2 Bagian', `pecahfile_2`), Markup.button.callback('✂️ 3 Bagian', `pecahfile_3`)],
            [Markup.button.callback('✂️ 4 Bagian', `pecahfile_4`), Markup.button.callback('✂️ 5 Bagian', `pecahfile_5`)],
            [Markup.button.callback('❌ Batal', 'pecahfile_cancel')],
        ]);
        
        setState(userId, { ...state, phase: 'choose_parts', contacts, baseName });
        await safeReply(ctx, `📋 Total kontak: ${contacts.length}\n\nPilih jumlah bagian:`, { ...keyboard });
    } catch (err) {
        log('ERROR', 'PecahFile', err.message, err);
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
        clearState(userId);
    }
}

// 12. /pecahctc - Pecah VCF Sesuai Jumlah Kontak
async function handlePecahCtcStart(ctx, userId, jumlah) {
    const count = Math.max(1, Math.min(1000, parseInt(jumlah) || 100));
    setState(userId, { mode: 'pecahctc', countPerFile: count, waiting: true });
    await safeReply(ctx, `✂️ *PECAH VCF (${count} kontak/file)*\n\nSilakan kirim file .vcf yang ingin dipecah.\nSetiap file akan berisi max ${count} kontak.`);
}

async function handlePecahCtcFile(ctx, userId, state) {
    const doc = ctx.message.document;
    const fname = doc.file_name || 'file.vcf';
    
    if (!fname.toLowerCase().endsWith('.vcf')) {
        return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    }
    
    try {
        const buffer = await downloadTelegramFile(ctx, doc.file_id);
        const vcfText = buffer.toString('utf-8');
        const contacts = parseVCF(vcfText);
        
        if (contacts.length === 0) {
            return safeReply(ctx, '❌ Tidak ada kontak valid.');
        }
        
        const countPerFile = state.countPerFile;
        const baseName = fname.replace(/\.vcf$/i, '');
        const totalParts = Math.ceil(contacts.length / countPerFile);
        
        for (let i = 0; i < totalParts; i++) {
            const partContacts = contacts.slice(i * countPerFile, (i + 1) * countPerFile);
            const vcfContent = generateVCF(partContacts);
            const vcfBuffer = Buffer.from(vcfContent, 'utf-8');
            const partNum = String(i + 1).padStart(3, '0');
            await sendFile(ctx, vcfBuffer, `${baseName}_${partNum}.vcf`, `📄 Bagian ${i + 1}/${totalParts}: ${partContacts.length} kontak`);
        }
        
        await safeReply(ctx, `✅ File berhasil dipecah menjadi ${totalParts} bagian\n📋 Total kontak: ${contacts.length}\n📏 Per file: ${countPerFile} kontak`);
        clearState(userId);
    } catch (err) {
        log('ERROR', 'PecahCtc', err.message, err);
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
        clearState(userId);
    }
}

// 13. /addctc - Tambah Kontak ke File VCF
async function handleAddCtcStart(ctx, userId) {
    setState(userId, { mode: 'addctc', phase: 'waiting_vcf' });
    await safeReply(ctx, `➕ *TAMBAH KONTAK VCF*\n\nSilakan kirim file .vcf yang ingin ditambahi kontak.`);
}

async function handleAddCtcFile(ctx, userId, state) {
    const doc = ctx.message.document;
    const fname = doc.file_name || 'file.vcf';
    
    if (!fname.toLowerCase().endsWith('.vcf')) {
        return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    }
    
    try {
        const buffer = await downloadTelegramFile(ctx, doc.file_id);
        const vcfText = buffer.toString('utf-8');
        const contacts = parseVCF(vcfText);
        
        if (contacts.length === 0) {
            return safeReply(ctx, '❌ Tidak ada kontak valid dalam file.');
        }
        
        setState(userId, { ...state, phase: 'waiting_contacts', existingContacts: contacts, fileName: fname });
        await safeReply(ctx, `📋 File: ${fname}\n👤 Kontak saat ini: ${contacts.length}\n\nSilakan kirim kontak tambahan dalam format teks (satu per baris):\n\`Nama Baru|081234567890\`\n\`081987654321\`\n\`+628123456789|Nama Lain\`\n\nKetik /done jika sudah selesai.`);
    } catch (err) {
        log('ERROR', 'AddCtc', err.message, err);
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
        clearState(userId);
    }
}

// 14. /delctc - Hapus Kontak di File VCF
async function handleDelCtcStart(ctx, userId) {
    setState(userId, { mode: 'delctc', phase: 'waiting_vcf' });
    await safeReply(ctx, `➖ *HAPUS KONTAK VCF*\n\nSilakan kirim file .vcf yang ingin dihapus kontaknya.`);
}

async function handleDelCtcFile(ctx, userId, state) {
    const doc = ctx.message.document;
    const fname = doc.file_name || 'file.vcf';
    
    if (!fname.toLowerCase().endsWith('.vcf')) {
        return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    }
    
    try {
        const buffer = await downloadTelegramFile(ctx, doc.file_id);
        const vcfText = buffer.toString('utf-8');
        const contacts = parseVCF(vcfText);
        
        if (contacts.length === 0) {
            return safeReply(ctx, '❌ Tidak ada kontak valid dalam file.');
        }
        
        // Tampilkan 50 kontak pertama
        let preview = `📋 *DAFTAR KONTAK*\n${DIVIDER}\nTotal: ${contacts.length} kontak\n\n`;
        const maxShow = Math.min(50, contacts.length);
        for (let i = 0; i < maxShow; i++) {
            const c = contacts[i];
            preview += `${i + 1}. ${esc(c.name)} → \`${c.phone}\`\n`;
        }
        if (contacts.length > 50) {
            preview += `\n... dan ${contacts.length - 50} kontak lainnya`;
        }
        preview += `\n\n${DIVIDER}\nKetik nomor urut yang ingin dihapus:\nFormat: \`1,3,5-8,10\`\nContoh: \`2,4,6-9\``;
        
        setState(userId, { ...state, phase: 'waiting_input', contacts, fileName: fname });
        await safeReply(ctx, preview);
    } catch (err) {
        log('ERROR', 'DelCtc', err.message, err);
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
        clearState(userId);
    }
}

// 15. /hitungctc - Hitung Total Kontak dalam VCF
async function handleHitungCtcStart(ctx, userId) {
    setState(userId, { mode: 'hitungctc', waiting: true });
    await safeReply(ctx, `🔢 *HITUNG KONTAK VCF*\n\nSilakan kirim file .vcf yang ingin dihitung.`);
}

async function handleHitungCtcFile(ctx, userId, state) {
    const doc = ctx.message.document;
    const fname = doc.file_name || 'file.vcf';
    
    if (!fname.toLowerCase().endsWith('.vcf')) {
        return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    }
    
    try {
        const buffer = await downloadTelegramFile(ctx, doc.file_id);
        const vcfText = buffer.toString('utf-8');
        const contacts = parseVCF(vcfText);
        
        let withName = 0;
        let withoutName = 0;
        const seenPhone = new Set();
        let dupCount = 0;
        
        for (const c of contacts) {
            if (c.name && c.name !== 'Tanpa Nama') {
                withName++;
            } else {
                withoutName++;
            }
            if (seenPhone.has(c.phone)) {
                dupCount++;
            } else {
                seenPhone.add(c.phone);
            }
        }
        
        const infoText = `🔢 HASIL HITUNG KONTAK VCF\n${DIVIDER}\n📇 File : ${fname}\n👤 Total kontak : ${contacts.length}\n✅ Punya nama : ${withName}\n❓ Tanpa nama : ${withoutName}\n📞 Nomor unik : ${seenPhone.size}\n🚫 Nomor duplikat : ${dupCount}\n${DIVIDER}`;
        
        await safeReply(ctx, infoText);
        clearState(userId);
    } catch (err) {
        log('ERROR', 'HitungCtc', err.message, err);
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
        clearState(userId);
    }
}

// 16. /totxt - Simpan Pesan ke File TXT
async function handleTotxtStart(ctx, userId) {
    setState(userId, { mode: 'totxt', messages: [], active: true });
    await safeReply(ctx, `📄 *PESAN KE TXT*\n\nMode pengumpulan pesan aktif.\nSetiap pesan teks yang kamu kirim akan disimpan.\n\nKetik /done untuk generate file TXT.\n\nMaks 500 pesan.`);
}

async function handleTotxtMessage(ctx, userId, state) {
    if (state.messages.length >= 500) {
        return safeReply(ctx, '⚠️ Sudah mencapai batas 500 pesan. Ketik /done untuk generate file.');
    }
    
    const msg = ctx.message.text;
    state.messages.push(msg);
    setState(userId, state);
    
    const count = state.messages.length;
    await safeReply(ctx, `✅ Pesan ke-${count} disimpan. Ketik /done untuk generate file.`);
}

async function finalizeTotxt(ctx, userId, state) {
    if (state.messages.length === 0) {
        clearState(userId);
        return safeReply(ctx, '❌ Tidak ada pesan yang dikumpulkan.');
    }
    
    try {
        const txtContent = state.messages.join('\n');
        const txtBuffer = Buffer.from(txtContent, 'utf-8');
        await sendFile(ctx, txtBuffer, `pesan_${Date.now()}.txt`, `✅ ${state.messages.length} pesan disimpan ke file TXT`);
        clearState(userId);
    } catch (err) {
        log('ERROR', 'Totxt', err.message, err);
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
        clearState(userId);
    }
}

// 17. /listgc - List Semua Grup WhatsApp
async function handleListGc(ctx, userId) {
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) {
        return safeReply(ctx, '❌ Login dulu! Ketik /login atau tekan tombol Login WhatsApp.');
    }
    
    try {
        const fetchAnim = await spinnerMessage(ctx, 'Mengambil daftar grup...');
        const chats = await session.sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        
        if (groups.length === 0) {
            await fetchAnim.stop('❌ Tidak ada grup ditemukan.');
            return;
        }
        
        // Urutkan berdasarkan jumlah member
        groups.sort((a, b) => (b.participants?.length || 0) - (a.participants?.length || 0));
        
        if (groups.length <= 20) {
            let listText = `📋 DAFTAR GRUP WA\n${DIVIDER}\nNo | Nama Grup | Member\n${DIVIDER}\n`;
            groups.forEach((g, i) => {
                const memberCount = g.participants?.length || 0;
                const name = g.subject.substring(0, 40);
                listText += `${i + 1} | ${esc(name)} | ${memberCount}\n`;
            });
            listText += `${DIVIDER}\nTotal: ${groups.length} grup`;
            await fetchAnim.stop(null);
            await safeReply(ctx, listText);
        } else {
            // Generate file TXT
            let listText = `DAFTAR GRUP WA\n${'='.repeat(50)}\n\n`;
            groups.forEach((g, i) => {
                const memberCount = g.participants?.length || 0;
                listText += `${i + 1}. ${g.subject} - ${memberCount} member\n`;
            });
            listText += `\n${'='.repeat(50)}\nTotal: ${groups.length} grup`;
            
            const txtBuffer = Buffer.from(listText, 'utf-8');
            await fetchAnim.stop(null);
            await sendFile(ctx, txtBuffer, `list_grup_${Date.now()}.txt`, `✅ Daftar ${groups.length} grup berhasil di-generate.`);
        }
    } catch (err) {
        log('ERROR', 'ListGc', err.message, err);
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
    }
}

// Handler untuk state mode 'totxt' - pesan teks dikumpulkan
tgBot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();
    
    const state = getState(userId);
    if (state && state.mode === 'totxt' && state.active && ctx.message?.text) {
        // Cek apakah ini command /done atau /selesai
        const cmd = ctx.message?.text?.startsWith('/');
        if (cmd) {
            const command = ctx.message.text.split(' ')[0].split('@')[0];
            if (command === '/done' || command === '/selesai') {
                return finalizeTotxt(ctx, userId, state);
            }
            return safeReply(ctx, '⚠️ Mode pengumpulan pesan aktif. Hanya /done yang diterima.');
        }
        return handleTotxtMessage(ctx, userId, state);
    }
    
    // Handler untuk state 'delctc' - input nomor urut
    if (state && state.mode === 'delctc' && state.phase === 'waiting_input' && ctx.message?.text) {
        const input = ctx.message.text.trim();
        const contacts = state.contacts;
        
        try {
            // Parse input: 1,3,5-8,10
            const toDelete = new Set();
            const parts = input.split(',');
            for (const part of parts) {
                if (part.includes('-')) {
                    const [start, end] = part.split('-').map(n => parseInt(n.trim()));
                    if (isNaN(start) || isNaN(end)) continue;
                    for (let i = Math.max(1, start); i <= Math.min(end, contacts.length); i++) {
                        toDelete.add(i);
                    }
                } else {
                    const num = parseInt(part.trim());
                    if (!isNaN(num) && num >= 1 && num <= contacts.length) {
                        toDelete.add(num);
                    }
                }
            }
            
            if (toDelete.size === 0) {
                return safeReply(ctx, '❌ Tidak ada nomor urut yang valid. Format: `1,3,5-8,10`');
            }
            
            // Hapus kontak (indeks dimulai dari 0)
            const deletedIndices = Array.from(toDelete).sort((a, b) => b - a); // Hapus dari belakang
            const newContacts = [...contacts];
            for (const idx of deletedIndices) {
                newContacts.splice(idx - 1, 1);
            }
            
            const vcfContent = generateVCF(newContacts);
            const baseName = state.fileName.replace(/\.vcf$/i, '');
            const vcfBuffer = Buffer.from(vcfContent, 'utf-8');
            
            await sendFile(ctx, vcfBuffer, `${baseName}_dihapus.vcf`, `✅ ${toDelete.size} kontak dihapus\nSisa: ${newContacts.length} kontak`);
            clearState(userId);
        } catch (err) {
            log('ERROR', 'DelCtc', err.message, err);
            await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
            clearState(userId);
        }
        return;
    }
    
    // Handler untuk state 'addctc' - input kontak tambahan
    if (state && state.mode === 'addctc' && state.phase === 'waiting_contacts' && ctx.message?.text) {
        const input = ctx.message.text.trim();
        const existingContacts = state.existingContacts;
        const seen = new Set(existingContacts.map(c => c.phone));
        
        const lines = input.split(/\r?\n/);
        const newContacts = [];
        let added = 0;
        let skipped = 0;
        
        for (const line of lines) {
            const parsed = autoDetectAndParse(line);
            if (!parsed) continue;
            const norm = normalizePhone(parsed.phone);
            if (!norm) continue;
            if (seen.has(norm)) {
                skipped++;
                continue;
            }
            seen.add(norm);
            newContacts.push({ name: parsed.name || `Kontak ${norm}`, phone: norm });
            added++;
        }
        
        if (newContacts.length === 0 && skipped > 0) {
            return safeReply(ctx, `⚠️ Semua kontak yang dikirim sudah ada di VCF (${skipped} duplikat).\n\nKirim kontak baru atau ketik /done untuk selesai.`);
        }
        
        if (newContacts.length === 0) {
            return safeReply(ctx, '❌ Tidak ada kontak valid yang ditemukan. Kirim lagi atau ketik /done.');
        }
        
        const allContacts = [...existingContacts, ...newContacts];
        const vcfContent = generateVCF(allContacts);
        const baseName = state.fileName.replace(/\.vcf$/i, '');
        const vcfBuffer = Buffer.from(vcfContent, 'utf-8');
        
        const infoText = `✅ ${added} kontak baru ditambahkan\n👤 Total: ${allContacts.length} kontak\n🚫 ${skipped} duplikat dilewati`;
        
        await sendFile(ctx, vcfBuffer, `${baseName}_updated.vcf`, infoText);
        clearState(userId);
        return;
    }
    
    return next();
});

// ========== TELEGRAM COMMANDS ==========
// Rate limit middleware
tgBot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId && isRateLimited(userId)) {
        try { await safeReply(ctx, '⏳ Terlalu cepat! Tunggu beberapa detik.'); } catch (e) {}
        return;
    }
    return next();
});

// ========== COMMAND BARU ==========

// /rekapgroup
tgBot.command('rekapgroup', requireAccess, async (ctx) => {
    await handleRekapGroup(ctx, ctx.from.id);
});

// /cv_txt_to_vcf
tgBot.command('cv_txt_to_vcf', requireAccess, async (ctx) => {
    await handleCvTxtToVcfStart(ctx, ctx.from.id);
});

// /cv_vcf_to_txt
tgBot.command('cv_vcf_to_txt', requireAccess, async (ctx) => {
    await handleCvVcfToTxtStart(ctx, ctx.from.id);
});

// /cv_xlsx_to_vcf
tgBot.command('cv_xlsx_to_vcf', requireAccess, async (ctx) => {
    await handleCvXlsxToVcfStart(ctx, ctx.from.id);
});

// /txt2vcf
tgBot.command('txt2vcf', requireAccess, async (ctx) => {
    await handleTxt2VcfStart(ctx, ctx.from.id);
});

// /cvadminfile
tgBot.command('cvadminfile', async (ctx) => {
    await handleCvAdminFile(ctx, ctx.from.id);
});

// /renamectc
tgBot.command('renamectc', requireAccess, async (ctx) => {
    await handleRenamectcStart(ctx, ctx.from.id);
});

// /renamefile
tgBot.command('renamefile', requireAccess, async (ctx) => {
    const args = ctx.message.text.split(' ');
    args.shift(); // Hapus command
    const newName = args.join(' ').trim();
    await handleRenameFileStart(ctx, ctx.from.id, newName);
});

// /gabungtxt
tgBot.command('gabungtxt', requireAccess, async (ctx) => {
    await handleGabungTxtStart(ctx, ctx.from.id);
});

// /gabungvcf
tgBot.command('gabungvcf', requireAccess, async (ctx) => {
    await handleGabungVcfStart(ctx, ctx.from.id);
});

// /pecahfile
tgBot.command('pecahfile', requireAccess, async (ctx) => {
    await handlePecahFileStart(ctx, ctx.from.id);
});

// /pecahctc
tgBot.command('pecahctc', requireAccess, async (ctx) => {
    const args = ctx.message.text.split(' ');
    const jumlah = args[1] || '100';
    await handlePecahCtcStart(ctx, ctx.from.id, jumlah);
});

// /addctc
tgBot.command('addctc', requireAccess, async (ctx) => {
    await handleAddCtcStart(ctx, ctx.from.id);
});

// /delctc
tgBot.command('delctc', requireAccess, async (ctx) => {
    await handleDelCtcStart(ctx, ctx.from.id);
});

// /hitungctc
tgBot.command('hitungctc', requireAccess, async (ctx) => {
    await handleHitungCtcStart(ctx, ctx.from.id);
});

// /totxt
tgBot.command('totxt', requireAccess, async (ctx) => {
    await handleTotxtStart(ctx, ctx.from.id);
});

// /listgc
tgBot.command('listgc', requireAccess, async (ctx) => {
    await handleListGc(ctx, ctx.from.id);
});

// /done dan /selesai
tgBot.command(['done', 'selesai'], requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const state = getState(userId);
    if (!state) return safeReply(ctx, '❌ Tidak ada proses yang sedang berjalan.');
    
    switch (state.mode) {
        case 'cv_txt_to_vcf': return finalizeCvTxtToVcf(ctx, userId, state);
        case 'cv_vcf_to_txt': return finalizeCvVcfToTxt(ctx, userId, state);
        case 'gabungtxt': return finalizeGabungTxt(ctx, userId, state);
        case 'gabungvcf': return finalizeGabungVcf(ctx, userId, state);
        case 'totxt': return finalizeTotxt(ctx, userId, state);
        default:
            clearState(userId);
            return safeReply(ctx, '✅ Proses dibatalkan.');
    }
});

// ========== INLINE BUTTON HANDLERS FITUR BARU ==========

// Admin file handlers
tgBot.action('adminfile_upload', async (ctx) => {
    await handleAdminFileUpload(ctx, ctx.from.id);
});

tgBot.action('adminfile_list', async (ctx) => {
    await handleAdminFileList(ctx, ctx.from.id);
});

tgBot.action('adminfile_delete', async (ctx) => {
    await handleAdminFileDelete(ctx, ctx.from.id);
});

tgBot.action('adminfile_download', async (ctx) => {
    await handleAdminFileDownload(ctx, ctx.from.id);
});

tgBot.action(/^adminfiledel_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
    const idx = parseInt(ctx.match[1]);
    const state = getState(ctx.from.id);
    if (!state || state.mode !== 'cvadminfile_delete' || !state.fileList) {
        return ctx.editMessageText('❌ Session expired. Coba lagi.');
    }
    
    const fileName = state.fileList[idx];
    if (!fileName) return ctx.editMessageText('❌ File tidak ditemukan.');
    
    try {
        const filePath = path.join(ADMIN_FILES_DIR, fileName);
        fs.unlinkSync(filePath);
        clearState(ctx.from.id);
        await ctx.editMessageText(`✅ File dihapus: ${esc(fileName)}`);
    } catch (err) {
        await ctx.editMessageText(`❌ Error: ${esc(err.message)}`);
    }
});

tgBot.action('adminfiledel_cancel', async (ctx) => {
    clearState(ctx.from.id);
    await ctx.editMessageText('✖ Dibatalkan.');
});

tgBot.action(/^adminfiledl_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();
    const idx = parseInt(ctx.match[1]);
    const state = getState(ctx.from.id);
    if (!state || state.mode !== 'cvadminfile_download' || !state.fileList) {
        return ctx.editMessageText('❌ Session expired. Coba lagi.');
    }
    
    const fileName = state.fileList[idx];
    if (!fileName) return ctx.editMessageText('❌ File tidak ditemukan.');
    
    try {
        const filePath = path.join(ADMIN_FILES_DIR, fileName);
        const buffer = fs.readFileSync(filePath);
        await sendFile(ctx, buffer, fileName, `📥 File: ${fileName}`);
        clearState(ctx.from.id);
    } catch (err) {
        await ctx.editMessageText(`❌ Error: ${esc(err.message)}`);
    }
});

tgBot.action('adminfiledl_cancel', async (ctx) => {
    clearState(ctx.from.id);
    await ctx.editMessageText('✖ Dibatalkan.');
});

// Rename contact handlers
tgBot.action('rename_prefix', async (ctx) => {
    await ctx.answerCbQuery();
    const state = getState(ctx.from.id);
    if (!state || state.mode !== 'renamectc') return;
    
    setState(ctx.from.id, { ...state, phase: 'input_prefix' });
    await safeReply(ctx, '✏️ Masukkan prefix yang ingin ditambahkan:\n\nContoh: `[Divisi A]` atau `Tim Marketing`\n\nHasil: "Tim Marketing Budi", "Tim Marketing Siti", dll.');
});

tgBot.action('rename_suffix', async (ctx) => {
    await ctx.answerCbQuery();
    const state = getState(ctx.from.id);
    if (!state || state.mode !== 'renamectc') return;
    
    setState(ctx.from.id, { ...state, phase: 'input_suffix' });
    await safeReply(ctx, '✏️ Masukkan suffix yang ingin ditambahkan:\n\nContoh: `(2024)`\n\nHasil: "Budi (2024)", "Siti (2024)", dll.');
});

tgBot.action('rename_numbered', async (ctx) => {
    await ctx.answerCbQuery();
    const state = getState(ctx.from.id);
    if (!state || state.mode !== 'renamectc') return;
    
    setState(ctx.from.id, { ...state, phase: 'input_numbered' });
    await safeReply(ctx, '✏️ Masukkan nama template:\n\nContoh: `Member`\n\nHasil: "Member 1", "Member 2", "Member 3", dll.');
});

tgBot.action('rename_cancel', async (ctx) => {
    clearState(ctx.from.id);
    await ctx.editMessageText('✖ Rename kontak dibatalkan.');
});

// Pecah file handlers
tgBot.action(/^pecahfile_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const parts = parseInt(ctx.match[1]);
    const state = getState(ctx.from.id);
    if (!state || state.mode !== 'pecahfile') return ctx.editMessageText('❌ Session expired.');
    
    const contacts = state.contacts;
    const baseName = state.baseName;
    const totalContacts = contacts.length;
    const perPart = Math.ceil(totalContacts / parts);
    
    try {
        for (let i = 0; i < parts; i++) {
            const partContacts = contacts.slice(i * perPart, (i + 1) * perPart);
            if (partContacts.length === 0) break;
            const vcfContent = generateVCF(partContacts);
            const vcfBuffer = Buffer.from(vcfContent, 'utf-8');
            await sendFile(ctx, vcfBuffer, `${baseName}_part${i + 1}.vcf`, `📄 Bagian ${i + 1}/${parts}: ${partContacts.length} kontak`);
        }
        await safeReply(ctx, `✅ File berhasil dipecah menjadi ${parts} bagian\n📋 Total kontak: ${totalContacts}`);
    } catch (err) {
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
    } finally {
        clearState(ctx.from.id);
    }
});

tgBot.action('pecahfile_cancel', async (ctx) => {
    clearState(ctx.from.id);
    await ctx.editMessageText('✖ Dibatalkan.');
});

// ========== DOCUMENT HANDLER TERPUSAT (UPGRADE) ==========
tgBot.on('document', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    
    // Cek state baru dulu
    const state = getState(userId);
    if (state) {
        switch (state.mode) {
            case 'cv_txt_to_vcf': return handleCvTxtToVcfFile(ctx, userId, state);
            case 'cv_vcf_to_txt': return handleCvVcfToTxtFile(ctx, userId, state);
            case 'cv_xlsx_to_vcf': return handleCvXlsxToVcfFile(ctx, userId, state);
            case 'txt2vcf': return handleTxt2VcfFile(ctx, userId, state);
            case 'gabungtxt': return handleGabungTxtFile(ctx, userId, state);
            case 'gabungvcf': return handleGabungVcfFile(ctx, userId, state);
            case 'pecahfile': return handlePecahFileVcf(ctx, userId, state);
            case 'pecahctc': return handlePecahCtcFile(ctx, userId, state);
            case 'addctc': return handleAddCtcFile(ctx, userId, state);
            case 'delctc': return handleDelCtcFile(ctx, userId, state);
            case 'hitungctc': return handleHitungCtcFile(ctx, userId, state);
            case 'renamectc': return handleRenamectcFile(ctx, userId, state);
            case 'renamefile': return handleRenameFile(ctx, userId, state);
            case 'cvadminfile_upload': return handleAdminFileUploadFile(ctx, userId, state);
        }
    }
    
    // Fallback ke handler VCF lama (importvcf ke WA)
    const pending = vcfPending.get(userId);
    if (!pending || !pending.waitingFile) return;
    
    const doc = ctx.message.document;
    const fname = doc.file_name || '';
    if (!fname.toLowerCase().endsWith('.vcf')) {
        return safeReply(ctx, '⚠️ File harus .vcf');
    }
    const MAX_VCF_SIZE = 5 * 1024 * 1024;
    if (doc.file_size && doc.file_size > MAX_VCF_SIZE) {
        vcfPending.delete(userId);
        return safeReply(ctx, `❌ File terlalu besar (${Math.round(doc.file_size/1024)}KB). Maks 5MB.`);
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

// ========== PHOTO HANDLER UNTUK REKAP GROUP ==========
tgBot.on('photo', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const state = getState(userId);
    
    if (state && state.mode === 'rekapgroup' && state.phase === 'waiting_photo') {
        return handleRekapGroupPhoto(ctx, userId, state);
    }
});

// ========== HEARS HANDLER UNTUK MENU BARU ==========

// File Tools menu
tgBot.hears('🔧 File Tools', requireAccess, async (ctx) => {
    await safeReply(ctx, `🔧 *FILE TOOLS MENU*\n\nPilih tool yang ingin digunakan:`, { ...KB_FILE_TOOLS });
});

tgBot.hears('↩️ Kembali', async (ctx) => {
    const kb = await getKeyboard(ctx.from.id);
    await safeReply(ctx, '↩️ Kembali ke menu utama.', { ...kb });
});

tgBot.hears('🔄 TXT → VCF', requireAccess, async (ctx) => {
    await handleCvTxtToVcfStart(ctx, ctx.from.id);
});

tgBot.hears('🔄 VCF → TXT', requireAccess, async (ctx) => {
    await handleCvVcfToTxtStart(ctx, ctx.from.id);
});

tgBot.hears('📊 XLSX → VCF', requireAccess, async (ctx) => {
    await handleCvXlsxToVcfStart(ctx, ctx.from.id);
});

tgBot.hears('📝 TXT2VCF Auto', requireAccess, async (ctx) => {
    await handleTxt2VcfStart(ctx, ctx.from.id);
});

tgBot.hears('🔗 Gabung TXT', requireAccess, async (ctx) => {
    await handleGabungTxtStart(ctx, ctx.from.id);
});

tgBot.hears('🔗 Gabung VCF', requireAccess, async (ctx) => {
    await handleGabungVcfStart(ctx, ctx.from.id);
});

tgBot.hears('✂️ Pecah VCF', requireAccess, async (ctx) => {
    await handlePecahFileStart(ctx, ctx.from.id);
});

tgBot.hears('✂️ Pecah VCF (jlh)', requireAccess, async (ctx) => {
    await safeReply(ctx, `Format: /pecahctc [jumlah]\n\nContoh:\n/pecahctc 50 — pecah jadi file-file berisi 50 kontak\n/pecahctc 100 — default\n\nKirim perintah /pecahctc dengan jumlah yang diinginkan.`);
});

tgBot.hears('➕ Tambah Kontak', requireAccess, async (ctx) => {
    await handleAddCtcStart(ctx, ctx.from.id);
});

tgBot.hears('➖ Hapus Kontak', requireAccess, async (ctx) => {
    await handleDelCtcStart(ctx, ctx.from.id);
});

tgBot.hears('🔢 Hitung Kontak', requireAccess, async (ctx) => {
    await handleHitungCtcStart(ctx, ctx.from.id);
});

tgBot.hears('✏️ Rename Kontak', requireAccess, async (ctx) => {
    await handleRenamectcStart(ctx, ctx.from.id);
});

tgBot.hears('📋 List Grup WA', requireAccess, async (ctx) => {
    await handleListGc(ctx, ctx.from.id);
});

tgBot.hears('📸 Rekap Grup', requireAccess, async (ctx) => {
    await handleRekapGroup(ctx, ctx.from.id);
});

tgBot.hears('📄 Pesan ke TXT', requireAccess, async (ctx) => {
    await handleTotxtStart(ctx, ctx.from.id);
});

tgBot.hears('📝 Rename File', requireAccess, async (ctx) => {
    await safeReply(ctx, `Format: /renamefile [nama_baru]\n\nContoh:\n/renamefile arisan_2024\n\nKirim perintah /renamefile dengan nama baru.`);
});

tgBot.hears('📁 Admin File Manager', async (ctx) => {
    await handleCvAdminFile(ctx, ctx.from.id);
});

// ========== ABORT / BATAL UNTUK SEMUA FITUR BARU ==========
tgBot.command('batal', async (ctx) => {
    const userId = ctx.from.id;
    const state = getState(userId);
    if (!state) return safeReply(ctx, '❌ Tidak ada proses yang sedang berjalan.');
    
    clearState(userId);
    await safeReply(ctx, '✅ Proses dibatalkan. State di-reset.');
});

// ========== AKSES CEPAT KE FILE TOOLS DARI START ==========
tgBot.command('filetools', requireAccess, async (ctx) => {
    await safeReply(ctx, `🔧 *FILE TOOLS MENU*\n\nPilih tool yang ingin digunakan:`, { ...KB_FILE_TOOLS });
});

// ========== HANDLER PESAN TEKS UNTUK RENAME KONTAK ==========
tgBot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();
    
    const state = getState(userId);
    if (!state || state.mode !== 'renamectc') return next();
    if (!ctx.message?.text) return next();
    
    const input = ctx.message.text.trim();
    const contacts = state.contacts;
    
    if (state.phase === 'input_prefix') {
        try {
            const renamed = contacts.map(c => ({
                name: `${input} ${c.name}`,
                phone: c.phone
            }));
            const vcfContent = generateVCF(renamed);
            const baseName = state.fileName.replace(/\.vcf$/i, '');
            const vcfBuffer = Buffer.from(vcfContent, 'utf-8');
            await sendFile(ctx, vcfBuffer, `${baseName}_prefix.vcf`, `✅ Prefix "${input}" ditambahkan ke ${contacts.length} kontak`);
            clearState(userId);
        } catch (err) {
            await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
            clearState(userId);
        }
        return;
    }
    
    if (state.phase === 'input_suffix') {
        try {
            const renamed = contacts.map(c => ({
                name: `${c.name} ${input}`,
                phone: c.phone
            }));
            const vcfContent = generateVCF(renamed);
            const baseName = state.fileName.replace(/\.vcf$/i, '');
            const vcfBuffer = Buffer.from(vcfContent, 'utf-8');
            await sendFile(ctx, vcfBuffer, `${baseName}_suffix.vcf`, `✅ Suffix "${input}" ditambahkan ke ${contacts.length} kontak`);
            clearState(userId);
        } catch (err) {
            await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
            clearState(userId);
        }
        return;
    }
    
    if (state.phase === 'input_numbered') {
        try {
            const renamed = contacts.map((c, i) => ({
                name: `${input} ${i + 1}`,
                phone: c.phone
            }));
            const vcfContent = generateVCF(renamed);
            const baseName = state.fileName.replace(/\.vcf$/i, '');
            const vcfBuffer = Buffer.from(vcfContent, 'utf-8');
            await sendFile(ctx, vcfBuffer, `${baseName}_numbered.vcf`, `✅ ${contacts.length} kontak di-rename menjadi "${input} 1" sampai "${input} ${contacts.length}"`);
            clearState(userId);
        } catch (err) {
            await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
            clearState(userId);
        }
        return;
    }
    
    return next();
});

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║    W A - K I C K E R   B O T   v 6 . 0 . 0                    ║');
console.log('║  F I L E   M A N A G E M E N T   E D I T I O N               ║');
console.log('╠══════════════════════════════════════════════════════════════╣');
console.log('║  17 FITUR BARU TELAH DITAMBAHKAN                             ║');
console.log('║  Gunakan /help untuk melihat panduan lengkap                  ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
