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
// ║         W A - K I C K E R   B O T   v 6 . 0 . 1            ║
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

// ========== PERSISTENT STORAGE - DIPINDAHKAN KE ATAS ==========
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const AUTH_BASE_FOLDER = path.join(DATA_DIR, 'auth_states');
if (!fs.existsSync(AUTH_BASE_FOLDER)) fs.mkdirSync(AUTH_BASE_FOLDER, { recursive: true });

// ADMIN_FILES_DIR setelah DATA_DIR didefinisikan
const ADMIN_FILES_DIR = process.env.ADMIN_FILES_DIR || path.join(DATA_DIR, 'admin_files');
if (!fs.existsSync(ADMIN_FILES_DIR)) fs.mkdirSync(ADMIN_FILES_DIR, { recursive: true });

// Try to load XLSX, but don't crash if not available
let XLSX = null;
try {
    XLSX = require('xlsx');
} catch (e) {
    console.log('⚠️  xlsx package tidak terinstall. Fitur /cv_xlsx_to_vcf tidak akan berfungsi.');
    console.log('   Install dengan: npm install xlsx');
}

const PAYMENT_INFO =
    `Transfer ke:\n` +
    `🏦 ${PAYMENT_BANK_NAME}: ${PAYMENT_BANK_NUMBER} a/n ${PAYMENT_BANK_HOLDER}\n` +
    `💚 Dana/Shopeepay: ${PAYMENT_DANA}`;

const PACKAGES = {
    '1bulan':  { label: '1 Bulan',  days: 30,  price: parseInt(process.env.PRICE_1BULAN  || '50000')  },
    '3bulan':  { label: '3 Bulan',  days: 90,  price: parseInt(process.env.PRICE_3BULAN  || '125000') },
    '6bulan':  { label: '6 Bulan',  days: 180, price: parseInt(process.env.PRICE_6BULAN  || '200000') },
    '1tahun':  { label: '1 Tahun',  days: 365, price: parseInt(process.env.PRICE_1TAHUN  || '350000') } };

// ========== DATABASE JSON ==========
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

// ... (fungsi startTrial, addPendingPayment, approvePayment, revokeUser, dll tetap sama)

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
            name = fnMatch[0].replace(/^FN.*?:/i, '').trim();
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
    
    // Format Navy: nomor di depan
    const navyMatch = line.match(/^(\+?[0-9]{10,15})\s+(.+)$/);
    if (navyMatch) return { phone: navyMatch[1], name: navyMatch[2].trim() };
    
    // Format nama|nomor atau nama,nomor
    const sepMatch = line.match(/^(.+?)[,|]\s*(\+?[0-9]{8,15})$/);
    if (sepMatch) return { phone: sepMatch[2], name: sepMatch[1].trim() };
    
    // Format nomor|nama atau nomor,nama
    const sepMatch2 = line.match(/^(\+?[0-9]{8,15})[,|]\s*(.+)$/);
    if (sepMatch2) return { phone: sepMatch2[1], name: sepMatch2[2].trim() };
    
    // Hanya nomor
    const phoneOnly = line.match(/^(\+?[0-9]{10,15})$/);
    if (phoneOnly) return { phone: phoneOnly[1], name: `Kontak ${phoneOnly[1]}` };
    
    // Tab-separated
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

// ... (KEYBOARDS, HUMAN DELAY, LOGIN, dll tetap sama)

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

// ========== FILE HANDLERS (TETAP SAMA SEPERTI SEBELUMNYA) ==========
// ... (semua handler file tetap sama)

// ========== TELEGRAM COMMANDS & HANDLERS ==========
// ... (semua commands, hears handlers, action handlers tetap sama)

// ========== DOCUMENT HANDLER TERPUSAT ==========
tgBot.on('document', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    
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
    
    // Fallback ke handler VCF lama
    const pending = vcfPending.get(userId);
    if (!pending || !pending.waitingFile) return;
    
    // ... kode VCF lama
});

// ========== HEALTH CHECK ==========
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', bot: 'WA Kicker Bot v6.0.1' }));
        return;
    }
    
    const apiKey = url.searchParams.get('key');
    if (apiKey !== HEALTH_API_KEY) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'ok',
        bot: 'WA Kicker Bot v6.0.1',
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
    console.log('║    W A - K I C K E R   B O T   v 6 . 0 . 1                    ║');
    console.log('║  F I L E   M A N A G E M E N T   E D I T I O N               ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Admin IDs      : ${ADMIN_IDS.join(', ')}`);
    console.log(`║  Trial          : ${TRIAL_DURATION_HOURS} jam`);
    console.log(`║  XLSX Support   : ${XLSX ? '✅ Ready' : '⚠️  Not Installed'}`);
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
}).catch(err => {
    console.error('❌ Gagal launch bot:', err.message);
    log('ERROR', 'Launch', 'Bot gagal start', err);
    process.exit(1);
});

process.on('SIGINT', () => { tgBot.stop('SIGINT'); process.exit(); });
process.on('SIGTERM', () => { tgBot.stop('SIGTERM'); process.exit(); });
process.on('uncaughtException', (err) => { log('ERROR', 'System', 'Uncaught Exception', err); });
process.on('unhandledRejection', (reason) => { log('ERROR', 'System', 'Unhandled Rejection', reason); });
