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
// ║         W A - K I C K E R   B O T   v 7 . 0 . 0            ║
// ║     MERGED: BADAK WA ENGINE + UPGRADED FILE TOOLS           ║
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
const HEALTH_API_KEY       = process.env.HEALTH_API_KEY || crypto.randomBytes(16).toString('hex');
const MAX_FILE_SIZE_MB      = parseInt(process.env.MAX_FILE_SIZE_MB || '10');
const MAX_FILES_PER_BATCH   = parseInt(process.env.MAX_FILES_PER_BATCH || '20');
const MAX_CONTACTS_PER_FILE = parseInt(process.env.MAX_CONTACTS_PER_FILE || '50000');
const MAX_ADMIN_FILES       = parseInt(process.env.MAX_ADMIN_FILES || '100');
const DOWNLOAD_TIMEOUT_MS   = parseInt(process.env.DOWNLOAD_TIMEOUT_MS || '30000');

const PAYMENT_INFO =
    `Transfer ke:\n` +
    `🏦 ${PAYMENT_BANK_NAME}: ${PAYMENT_BANK_NUMBER} a/n ${PAYMENT_BANK_HOLDER}\n` +
    `💚 Dana/Shopeepay: ${PAYMENT_DANA}`;

const PACKAGES = {
    '1bulan':  { label: '1 Bulan',  days: 30,  price: parseInt(process.env.PRICE_1BULAN  || '50000')  },
    '3bulan':  { label: '3 Bulan',  days: 90,  price: parseInt(process.env.PRICE_3BULAN  || '125000') },
    '6bulan':  { label: '6 Bulan',  days: 180, price: parseInt(process.env.PRICE_6BULAN  || '200000') },
    '1tahun':  { label: '1 Tahun',  days: 365, price: parseInt(process.env.PRICE_1TAHUN  || '350000') }
};

// ========== PERSISTENT STORAGE ==========
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const AUTH_BASE_FOLDER = path.join(DATA_DIR, 'auth_states');
if (!fs.existsSync(AUTH_BASE_FOLDER)) fs.mkdirSync(AUTH_BASE_FOLDER, { recursive: true });

const ADMIN_FILES_DIR = process.env.ADMIN_FILES_DIR || path.join(DATA_DIR, 'admin_files');
if (!fs.existsSync(ADMIN_FILES_DIR)) fs.mkdirSync(ADMIN_FILES_DIR, { recursive: true });

const TEMP_DIR = path.join(DATA_DIR, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

let XLSX = null;
try {
    XLSX = require('xlsx');
    console.log('✅ xlsx package loaded successfully');
} catch (e) {
    console.log('⚠️  xlsx package tidak terinstall. Fitur XLSX → VCF tidak akan berfungsi.');
}

// ========== DATABASE JSON ==========
const USERS_FILE    = path.join(DATA_DIR, 'users.json');
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
        return users[String(userId)] || null;
    }

    saveUser(user) {
        const users = readJSON(USERS_FILE);
        users[String(user.id)] = {
            ...user,
            hadTrial:       user.hadTrial       ? 1 : 0,
            notifiedExpiry: user.notifiedExpiry ? 1 : 0,
            updatedAt:      new Date().toISOString()
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

// ========== LOGGER ==========
const LOG_LEVELS = { INFO: '📘', WARN: '⚠️', ERROR: '❌', DEBUG: '🐛' };

function log(level, module, message, error = null) {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} ${LOG_LEVELS[level] || '📘'} [${module}] ${message}`;
    console.log(logEntry);
    if (error && level === 'ERROR') {
        console.error(error.stack);
        try { fs.appendFileSync(path.join(DATA_DIR, 'error.log'), `${logEntry}\n${error?.stack || ''}\n\n`); } catch (_) {}
    }
}

// ========== GLOBAL STATE ==========
const tgBot              = new Telegraf(TELEGRAM_BOT_TOKEN);
const userStates         = new Map();
const userSessions       = new Map();
const kickSelections     = new Map();
const loginLocks         = new Map();
const vcfPending         = new Map();
const conflictCooldowns  = new Map();
const reconnectAttempts  = new Map();

const CONFLICT_COOLDOWN_MS     = 35000;
const MAX_RECONNECT_ATTEMPTS   = 3;
const MAX_CONCURRENT_SESSIONS  = 50;
const SESSION_IDLE_MS          = 4 * 60 * 60 * 1000;
const STATE_TTL_MS             = 30 * 60 * 1000;

// ========== RATE LIMITER ==========
const rateLimitMap         = new Map();
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX       = 10;

function isRateLimited(userId) {
    const now   = Date.now();
    const entry = rateLimitMap.get(userId) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    if (now > entry.resetAt) {
        entry.count   = 1;
        entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
    } else {
        entry.count++;
    }
    rateLimitMap.set(userId, entry);
    return entry.count > RATE_LIMIT_MAX;
}

tgBot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId && isRateLimited(userId)) {
        try { await safeReply(ctx, '⏳ Terlalu cepat! Tunggu beberapa detik.'); } catch (_) {}
        return;
    }
    return next();
});

// ========== FUNGSI HELPERS ==========
function isAdmin(userId) { return ADMIN_IDS.includes(userId); }

async function getUserStatus(userId) {
    if (isAdmin(userId)) return 'admin';
    const u = db.getUser(userId);
    if (!u) return 'none';
    if (u.role === 'regular') return new Date(u.expiresAt) > new Date() ? 'regular' : 'expired';
    if (u.role === 'trial')   return new Date(u.trialExpiresAt) > new Date() ? 'trial' : 'trial_expired';
    return 'none';
}

async function canUseBot(userId) {
    const status = await getUserStatus(userId);
    return ['admin', 'regular', 'trial'].includes(status);
}

async function isTrialOnly(userId) {
    return (await getUserStatus(userId)) === 'trial';
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
    const mins  = Math.floor((ms % 3600000) / 60000);
    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        return `${days} hari ${hours % 24} jam`;
    }
    return `${hours} jam ${mins} menit`;
}

function formatRupiah(num) { return 'Rp ' + num.toLocaleString('id-ID'); }

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

const DIVIDER      = '━━━━━━━━━━━━━━━━━━━━━━';
const DIVIDER_THIN = '┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄';

function normalizePhone(raw) {
    const str     = String(raw).trim();
    const hasPlus = str.startsWith('+');
    let digits    = str.replace(/\D/g, '');
    if (!digits) return null;
    if (hasPlus || digits.startsWith('00')) {
        const withCC = hasPlus ? digits : digits.slice(2);
        if (withCC.length >= 7) return withCC;
    }
    if (digits.startsWith('0'))  return '62' + digits.slice(1);
    if (digits.startsWith('62')) return digits;
    if (digits.length >= 9)      return '62' + digits;
    return digits.length >= 7 ? digits : null;
}

function isPhoneNumber(val) {
    const str = String(val).replace(/[\s\-().]/g, '');
    return /^(\+?62|0)[0-9]{8,13}$/.test(str) || /^[0-9]{10,15}$/.test(str);
}

function safeFilename(name) {
    const base = path.basename(name);
    return base.replace(/[\/\\:*?"<>|]/g, '_').substring(0, 100);
}

async function safeReply(ctx, text, opts = {}) {
    const mdOpts = { parse_mode: 'Markdown', ...opts };
    try {
        return await ctx.reply(text, mdOpts);
    } catch (err) {
        if (err.message && (err.message.includes('parse entities') || err.message.includes('Bad Request'))) {
            const { parse_mode, ...safeOpts } = mdOpts;
            try {
                return await ctx.reply(text.replace(/[*_`[\]()~>#+=|{}.!\\-]/g, '\\$&'), { ...safeOpts });
            } catch (err2) {
                return await ctx.reply(text.replace(/[*_`[\]()~>#+=|{}.!\\-]/g, ''), safeOpts);
            }
        }
        log('WARN', 'SafeReply', `Gagal kirim pesan: ${err.message}`);
    }
}

async function downloadTelegramFile(ctx, fileId, fileSizeMB = null) {
    if (fileSizeMB !== null && fileSizeMB > MAX_FILE_SIZE_MB)
        throw new Error(`File terlalu besar. Maks ${MAX_FILE_SIZE_MB}MB.`);

    const fileLink   = await ctx.telegram.getFileLink(fileId);
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    try {
        const resp = await fetch(fileLink.href, { signal: controller.signal });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} saat download file`);
        const buffer = Buffer.from(await resp.arrayBuffer());
        if (buffer.length > MAX_FILE_SIZE_MB * 1024 * 1024)
            throw new Error(`File terlalu besar. Maks ${MAX_FILE_SIZE_MB}MB.`);
        return buffer;
    } catch (err) {
        if (err.name === 'AbortError') throw new Error(`Download timeout setelah ${DOWNLOAD_TIMEOUT_MS / 1000}s.`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

function bytesToMB(bytes) { return bytes ? bytes / (1024 * 1024) : null; }

async function sendFile(ctx, buffer, filename, caption = '') {
    await ctx.replyWithDocument(
        { source: buffer, filename },
        caption ? { caption } : {}
    );
}

function generateVCF(contacts) {
    const seen = new Set();
    const unique = [];
    for (const { name, phone } of contacts) {
        const norm = normalizePhone(phone);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        unique.push({ name: name || `Kontak ${phone}`, phone: norm });
    }
    return unique.map(({ name, phone }) =>
        `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;TYPE=CELL:+${phone}\nEND:VCARD`
    ).join('\n');
}

function decodeQP(str) {
    return str.replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function parseVCF(vcfText) {
    const contacts = [];
    const seen     = new Set();
    const blocks   = vcfText.split(/END:VCARD/i).map(b => b.trim()).filter(Boolean);

    for (const block of blocks) {
        if (contacts.length >= MAX_CONTACTS_PER_FILE) {
            log('WARN', 'parseVCF', `Batas ${MAX_CONTACTS_PER_FILE} kontak tercapai.`);
            break;
        }
        let name = 'Tanpa Nama';
        const fnMatch = block.match(/^FN[;:][^\r\n]*/mi);
        const nMatch  = block.match(/^N[;:][^\r\n]*/mi);
        if (fnMatch) {
            const qpMatch = fnMatch[0].match(/ENCODING=QUOTED-PRINTABLE.*?:(.*)/i);
            if (qpMatch) {
                try { name = decodeQP(qpMatch[1].trim()); } catch (_) {}
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
            if (!num || seen.has(num)) continue;
            seen.add(num);
            contacts.push({ name, phone: num });
        }
    }
    return contacts;
}

function autoDetectAndParse(line) {
    line = line.trim();
    if (!line) return null;

    const navyMatch = line.match(/^(\+?[0-9]{10,15})\s+(.+)$/);
    if (navyMatch) return { phone: navyMatch[1], name: navyMatch[2].trim() };

    const sepMatch = line.match(/^(.+?)[,|]\s*(\+?[0-9]{8,15})$/);
    if (sepMatch) return { phone: sepMatch[2], name: sepMatch[1].trim() };

    const sepMatch2 = line.match(/^(\+?[0-9]{8,15})[,|]\s*(.+)$/);
    if (sepMatch2) return { phone: sepMatch2[1], name: sepMatch2[2].trim() };

    const phoneOnly = line.match(/^(\+?[0-9]{10,15})$/);
    if (phoneOnly) return { phone: phoneOnly[1], name: `Kontak ${phoneOnly[1]}` };

    const tabMatch = line.match(/^(.+?)\t(\+?[0-9]{8,15})$/);
    if (tabMatch) {
        const a = tabMatch[1].trim();
        const b = tabMatch[2].trim();
        if (/^\+?[0-9]{10,15}$/.test(a.replace(/[\s\-().]/g, '')))
            return { phone: a, name: b };
        return { phone: b, name: a };
    }
    return null;
}

function parseTxtLines(text) {
    const lines    = text.split(/\r?\n/);
    const contacts = [];
    const seen     = new Set();

    for (const line of lines) {
        if (contacts.length >= MAX_CONTACTS_PER_FILE) {
            log('WARN', 'parseTxtLines', `Batas ${MAX_CONTACTS_PER_FILE} kontak tercapai.`);
            break;
        }
        const parsed = autoDetectAndParse(line);
        if (!parsed) continue;
        const norm = normalizePhone(parsed.phone);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        contacts.push({ name: parsed.name || `Kontak ${norm}`, phone: norm });
    }
    return contacts;
}

// ========== STATE MANAGEMENT ==========
function setState(userId, data) {
    userStates.set(userId, { ...data, expiresAt: Date.now() + STATE_TTL_MS });
}
function getState(userId) {
    const state = userStates.get(userId);
    if (!state) return null;
    if (Date.now() > state.expiresAt) { userStates.delete(userId); return null; }
    return state;
}
function clearState(userId) { userStates.delete(userId); }

// ========== MEMORY MONITOR ==========
setInterval(() => {
    const mem = process.memoryUsage();
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
    const rssMB  = Math.round(mem.rss / 1024 / 1024);
    log('INFO', 'Memory', `Heap: ${heapMB}MB | RSS: ${rssMB}MB | Sessions: ${userSessions.size}`);
    if (heapMB > 400) log('WARN', 'Memory', `Heap tinggi (${heapMB}MB)`);
}, 30 * 60 * 1000);

// ========== AUTO BACKUP JSON ==========
function backupData() {
    try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        if (fs.existsSync(USERS_FILE))    fs.copyFileSync(USERS_FILE,    path.join(BACKUP_DIR, `users_${ts}.json`));
        if (fs.existsSync(PAYMENTS_FILE)) fs.copyFileSync(PAYMENTS_FILE, path.join(BACKUP_DIR, `payments_${ts}.json`));
        const files = fs.readdirSync(BACKUP_DIR).sort();
        const userB = files.filter(f => f.startsWith('users_'));
        const payB  = files.filter(f => f.startsWith('payments_'));
        userB.slice(0, Math.max(0, userB.length - 24)).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
        payB.slice(0, Math.max(0, payB.length - 24)).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
        log('INFO', 'Backup', `Backup berhasil: ${ts}`);
    } catch (err) {
        log('ERROR', 'Backup', `Gagal backup: ${err.message}`, err);
    }
}
setInterval(backupData, 60 * 60 * 1000);
setTimeout(backupData, 5000);

// ========== CLEANUP INTERVALS ==========
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
    for (const [uid, entry] of rateLimitMap.entries())
        if (now > entry.resetAt + 60000) rateLimitMap.delete(uid);
    for (const [uid, s] of userStates.entries())
        if (s.expiresAt && now > s.expiresAt) userStates.delete(uid);
    for (const [uid, p] of vcfPending.entries())
        if (p.createdAt && now - p.createdAt > 15 * 60 * 1000) vcfPending.delete(uid);
    for (const [uid, t] of loginLocks.entries())
        if (now - t > 5 * 60 * 1000) loginLocks.delete(uid);
}, 30 * 60 * 1000);

function touchSession(userId) {
    const sess = userSessions.get(userId);
    if (sess) sess.lastActivity = Date.now();
}

// ========== HUMAN DELAY ENGINE (FROM BADAK) ==========
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

function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

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
    log('INFO', 'HumanDelay', `Long break [${label}]: ${Math.round(delaySec / 60)} menit`);
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
    return parseInt(hour) >= 8 && parseInt(hour) <= 22;
}

// ========== DYNAMIC FINGERPRINT ==========
function generateDynamicFingerprint() {
    const chromeVersions = ['120', '121', '122', '123', '124'];
    const edgeVersions   = ['120', '121', '122'];
    const safariVersions = ['16', '17', '17.4'];
    const osList         = ['Windows', 'MacOS', 'Linux'];
    const os             = osList[Math.floor(Math.random() * osList.length)];

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
const CLOCK_FRAMES   = ['🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕛'];
const PULSE_FRAMES   = ['🔴', '🟠', '🟡', '🟢', '🟡', '🟠'];

async function liveMessage(ctx, initText, frameFn, interval = 900) {
    let msg;
    try {
        msg = await ctx.reply(initText, { parse_mode: 'Markdown' });
    } catch (err) {
        try { msg = await safeReply(ctx, initText); } catch (_) {
            return { stop: async () => {} };
        }
    }

    let frame = 0, stopped = false;
    const timer = setInterval(async () => {
        if (stopped) return;
        try {
            await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined, frameFn(frame), { parse_mode: 'Markdown' });
        } catch (_) {}
        frame++;
    }, interval);

    return {
        stop: async (finalText) => {
            stopped = true;
            clearInterval(timer);
            if (finalText) {
                try {
                    await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined, finalText, { parse_mode: 'Markdown' });
                } catch (_) {}
            }
        }
    };
}

async function spinnerMessage(ctx, label) {
    return liveMessage(ctx, `${SPINNER_FRAMES[0]} *${label}*`, (i) => `${SPINNER_FRAMES[i % SPINNER_FRAMES.length]} *${label}*`, 750);
}

function buildProgressBar(done, total, width = 14) {
    const pct    = total === 0 ? 1 : Math.min(done / total, 1);
    const filled = Math.round(pct * width);
    const empty  = width - filled;
    return '[' + '█'.repeat(filled) + '░'.repeat(empty) + '] ' + String(Math.round(pct * 100)).padStart(3) + '%';
}

async function liveKickProgress(ctx, total) {
    let current = 0;
    const anim = await liveMessage(ctx,
        `🦵 *Memulai kick...*\n${buildProgressBar(0, total)}\n0/${total} orang`,
        (i) => {
            const spin  = SPINNER_FRAMES[i % SPINNER_FRAMES.length];
            const pulse = PULSE_FRAMES[i % PULSE_FRAMES.length];
            return `${pulse} *Sedang mengkick anggota...*\n\n${buildProgressBar(current, total)}\n${spin} \`${current}/${total}\` orang dikick\n\n_Sabar, jeda antar kick untuk stealth mode..._`;
        }, 800);
    return {
        update: (n) => { current = n; },
        stop:   (finalText) => anim.stop(finalText)
    };
}

async function liveCountdown(ctx, totalMs, headerText, onDone) {
    const endTime = Date.now() + totalMs;
    const anim    = await liveMessage(ctx, `⏳ ${headerText}\n\nMenghitung...`,
        (i) => {
            const left  = Math.max(0, endTime - Date.now());
            const sisa  = Math.ceil(left / 1000);
            const clock = CLOCK_FRAMES[i % CLOCK_FRAMES.length];
            const pulse = PULSE_FRAMES[i % PULSE_FRAMES.length];
            const menit = String(Math.floor(sisa / 60)).padStart(2, '0');
            const detik = String(sisa % 60).padStart(2, '0');
            const bar   = buildProgressBar(totalMs - left, totalMs, 14);
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
            const spin  = SPINNER_FRAMES[i % SPINNER_FRAMES.length];
            const clock = CLOCK_FRAMES[i % CLOCK_FRAMES.length];
            return `${clock} Menghubungkan ke WhatsApp\n\n${spin} ${labels[phase]}...\n\n_QR code akan muncul sebentar lagi_`;
        }, 700);
}

// ========== QR SENDER ==========
async function sendQR(ctx, qr) {
    if (!qr) { await safeReply(ctx, `❌ QR code kosong, coba lagi.`); return; }
    await humanDelay(1800, 3600);
    const sendAsText = Math.random() < 0.25;
    try {
        if (!sendAsText) {
            const qrBuffer = await QRCode.toBuffer(qr, { type: 'png', width: 1024, margin: 2, color: { dark: '#000000', light: '#FFFFFF' }, scale: 8 });
            await ctx.replyWithPhoto({ source: qrBuffer }, {
                caption: `📱 SCAN QR CODE DI WHATSAPP\n\n1. Buka WhatsApp di HP\n2. Tap ⋮ (titik tiga) → Perangkat Tertaut\n3. Tap Tautkan Perangkat\n4. Scan QR code di atas\n\n_Kalo gagal scan, screenshot aja terus scan dari galeri_`
            });
        } else {
            await safeReply(ctx, `📱 SCAN QR CODE MANUAL\n\n1. Buka WhatsApp → Perangkat Tertaut\n2. Tautkan Perangkat\n3. Scan kode dibawah (screenshot):\n\n\`\`\`\n${qr}\n\`\`\``);
        }
    } catch (err) {
        await safeReply(ctx, `📱 SCAN QR CODE (Teks Backup)\n\n\`\`\`\n${qr}\n\`\`\``);
    }
}

// ========== NATURAL KICK ONE BY ONE ==========
async function naturalKickOneByOne(sock, groupId, jids, onProgress) {
    let totalKicked = 0;
    const shuffledJids = [...jids];
    for (let i = shuffledJids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledJids[i], shuffledJids[j]] = [shuffledJids[j], shuffledJids[i]];
    }

    let mood = getSessionMood();
    let actionsSinceMoodChange = 0;
    let moodChangeTrigger = 5 + Math.floor(Math.random() * 6);

    for (let i = 0; i < shuffledJids.length; i++) {
        const jid = shuffledJids[i];
        actionsSinceMoodChange++;
        if (actionsSinceMoodChange >= moodChangeTrigger) {
            mood = getSessionMood();
            actionsSinceMoodChange = 0;
            moodChangeTrigger = 5 + Math.floor(Math.random() * 6);
            log('INFO', 'Kick', `Mood berubah → ${mood}`);
        }
        try {
            await simulateReadAndType(sock, groupId, false);
            await sock.groupParticipantsUpdate(groupId, [jid], 'remove');
            totalKicked++;
            if (onProgress) onProgress(totalKicked);
            log('INFO', 'Kick', `✅ Kick ${jid} (${totalKicked}/${shuffledJids.length}) [${mood}]`);
            if (i + 1 < shuffledJids.length) {
                if (Math.random() < 0.08) {
                    log('INFO', 'Kick', `Ambil napas panjang setelah ${totalKicked} kick...`);
                    await humanDelayLongBreak('kick-break');
                    mood = getSessionMood();
                    actionsSinceMoodChange = 0;
                } else {
                    await humanDelayKick(mood);
                }
            }
        } catch (err) {
            log('ERROR', 'Kick', `Gagal kick ${jid}: ${err.message}`);
            if (err.message && (err.message.includes('Connection Closed') || err.message.includes('Connection Lost'))) {
                return { kicked: totalKicked, stopped: true, reason: 'connection' };
            }
            await humanDelayError();
        }
    }
    return { kicked: totalKicked, stopped: false };
}

// ========== ADD CONTACTS TO GROUP ==========
async function addContactsToGroup(ctx, userId, contacts, groupId, groupName) {
    touchSession(userId);
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) {
        return safeReply(ctx, '❌ Session WA berakhir. Tekan 🔑 Login WhatsApp.');
    }

    const total = contacts.length;
    let berhasil = 0, gagal = 0, notWA = 0;
    const statusMsg = await safeReply(ctx, `⏳ Menambahkan ${total} kontak ke grup...\n\n⚠️ Proses berjalan lambat dan natural untuk keamanan WA.`);

    let mood = getSessionMood();
    let actionsSinceMoodChange = 0;
    let moodChangeTrigger = 4 + Math.floor(Math.random() * 5);

    for (let i = 0; i < contacts.length; i++) {
        const currentSession = userSessions.get(userId);
        if (!currentSession || !currentSession.loggedIn) {
            await safeReply(ctx, `⚠️ Session WA terputus di tengah proses.\n\n✅ Berhasil: ${berhasil}\n📵 No WA: ${notWA}\n❌ Error/Belum: ${total - berhasil - notWA}\n\nLogin ulang dan coba lagi.`);
            vcfPending.delete(userId);
            return;
        }

        actionsSinceMoodChange++;
        if (actionsSinceMoodChange >= moodChangeTrigger) {
            mood = getSessionMood();
            actionsSinceMoodChange = 0;
            moodChangeTrigger = 4 + Math.floor(Math.random() * 5);
        }

        const c = contacts[i];
        try {
            const [result] = await currentSession.sock.onWhatsApp(c.phone);
            if (!result || !result.exists) {
                notWA++;
                if (i + 1 < contacts.length) await humanDelayNatural(3, 8);
                continue;
            }
            await simulateReadAndType(currentSession.sock, groupId, true);
            await currentSession.sock.groupParticipantsUpdate(groupId, [result.jid], 'add');
            berhasil++;
            try {
                await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
                    `⏳ Progres: ${i + 1}/${total}\n✅ Berhasil: ${berhasil} | 📵 No WA: ${notWA} | ❌ Error: ${gagal}\n\n_Mood: ${mood}_`);
            } catch (_) {}
            if (i + 1 < contacts.length) {
                if (Math.random() < 0.10) {
                    try {
                        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
                            `⏸️ Jeda sejenak... (${berhasil} dari ${total} selesai)\n✅ Berhasil: ${berhasil} | 📵 No WA: ${notWA}\n\n_Ini normal, menghindari deteksi WA._`);
                    } catch (_) {}
                    await humanDelayLongBreak('add-break');
                    mood = getSessionMood();
                    actionsSinceMoodChange = 0;
                } else {
                    await humanDelayAdd(mood);
                }
            }
        } catch (err) {
            gagal++;
            log('ERROR', 'Add', `${c.phone}: ${err.message}`, err);
            if (err.message && (err.message.includes('Connection Closed') || err.message.includes('Connection Lost'))) {
                await safeReply(ctx, `🔴 Koneksi WA terputus saat proses.\n\n✅ Berhasil: ${berhasil}\n📵 No WA: ${notWA}\n❌ Gagal/Belum: ${total - berhasil - notWA}\n\nTekan 🔑 Login WhatsApp untuk login ulang.`);
                vcfPending.delete(userId);
                return;
            }
            await humanDelayError();
        }
    }

    await safeReply(ctx, `╔${DIVIDER}╗\n║  HASIL IMPORT VCF\n╚${DIVIDER}╝\n\n🎯 Grup: ${esc(groupName)}\n\n${DIVIDER_THIN}\n✅ Berhasil ditambah: ${berhasil} kontak\n📵 Tidak punya WA: ${notWA} kontak\n❌ Error: ${gagal} kontak\n`);
    vcfPending.delete(userId);
}

// ========== DESTROY SESSION ==========
async function destroySession(userId) {
    const old = userSessions.get(userId);
    if (!old) return;
    if (old.qrTimer)    clearTimeout(old.qrTimer);
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

// ========== LOGIN (FROM BADAK) ==========
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
            auth:                      state,
            browser:                   browserProfile,
            logger:                    pino({ level: 'silent' }),
            connectTimeoutMs:          60000,
            defaultQueryTimeoutMs:     30000,
            keepAliveIntervalMs:       30000,
            retryRequestDelayMs:       500,
            version,
            generateHighQualityLinkPreview: false,
            printQRInTerminal:         false,
            shouldReconnect:           () => false
        });
        const session = {
            sock, saveCreds,
            qrTimer: null, reconnTimer: null,
            lastQR: null, qrBlocked: false,
            loggedIn: false, groupId: null, groupName: null, members: [],
            _groupPickerList: null,
            _vcfGroupPickerList: null,
            createdAt:    Date.now(),
            lastActivity: Date.now()
        };
        userSessions.set(userId, session);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                session.lastQR = qr;
                if (!session.qrBlocked) {
                    session.qrBlocked = true;
                    try { await connectAnim.stop(null); } catch (_) {}
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
                if (session.qrTimer)    clearTimeout(session.qrTimer);
                if (session.reconnTimer) clearTimeout(session.reconnTimer);
                const err        = lastDisconnect?.error;
                const statusCode = err?.output?.statusCode ?? err?.output?.payload?.statusCode;
                const attempts   = (reconnectAttempts.get(userId) || 0) + 1;
                log('INFO', 'Connection', `[${userId}] WA close — code=${statusCode}, attempt=${attempts}`);
                if (statusCode === 515) {
                    sock.ev.removeAllListeners();
                    userSessions.delete(userId);
                    reconnectAttempts.delete(userId);
                    conflictCooldowns.set(userId, Date.now() + CONFLICT_COOLDOWN_MS);
                    try { await connectAnim.stop(null); } catch (_) {}
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
                    const delayMs  = Math.min(5000 * Math.pow(2, attempts - 1), 30000);
                    const delaySec = Math.ceil(delayMs / 1000);
                    sock.ev.removeAllListeners();
                    userSessions.delete(userId);
                    await safeReply(ctx, `🔌 Koneksi terputus (code: ${statusCode || '?'}).\n🔄 Reconnect otomatis dalam ${delaySec} detik... (percobaan ${attempts}/${MAX_RECONNECT_ATTEMPTS})`);
                    const reconnTimer = setTimeout(async () => {
                        try { await startLogin(ctx, userId); }
                        catch (e) { log('ERROR', 'Login', 'Auto-reconnect error', e); }
                    }, delayMs);
                    const pendingReconn = userSessions.get(userId);
                    if (pendingReconn) pendingReconn.reconnTimer = reconnTimer;
                    else userSessions.set(userId, { reconnTimer, loggedIn: false, _pendingReconn: true });
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
                try { await connectAnim.stop(null); } catch (_) {}
                try { await sock.sendPresenceUpdate('available'); } catch (_) {}
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

// ========== GROUP & KICK MENU ==========
async function showGroupPicker(ctx, userId, session) {
    touchSession(userId);
    const fetchAnim = await spinnerMessage(ctx, 'Mengambil daftar grup...');
    try {
        const chats  = await session.sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        if (groups.length === 0) {
            await fetchAnim.stop(`❌ Tidak ada grup ditemukan.`);
            return;
        }
        const isTrial      = await isTrialOnly(userId);
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
    touchSession(userId);
    const fetchAnim = await spinnerMessage(ctx, 'Mengambil daftar anggota...');
    try {
        const metadata = await session.sock.groupMetadata(session.groupId);
        const myJid    = session.sock.user.id.replace(/:.*@/, '@');
        const allMembers = metadata.participants.filter(p => {
            const isMe  = p.id === myJid || p.id.split('@')[0] === myJid.split('@')[0];
            const isAdm = p.admin === 'admin' || p.admin === 'superadmin';
            return !isMe && !isAdm;
        }).map(p => ({ jid: p.id, name: p.id.split('@')[0] }));

        if (allMembers.length === 0) {
            await fetchAnim.stop(null);
            return safeReply(ctx, `ℹ️ Tidak ada anggota yang bisa dikick.\n\nSemua anggota adalah admin.`);
        }
        session.members = allMembers;
        kickSelections.set(userId, new Set());
        await fetchAnim.stop(null);
        await safeReply(ctx, `╔${DIVIDER}╗\n║  MENU KICK ANGGOTA\n╚${DIVIDER}╝\n\n🎯 Grup: ${esc(session.groupName || '')}\n👥 Non-admin: ${allMembers.length} orang\n\nKetuk nama untuk pilih/batal.\nTekan Kick Terpilih jika sudah siap.\n\n⚠️ _Aksi kick tidak bisa dibatalkan!_`, { ...buildMemberKeyboard(allMembers, kickSelections.get(userId)) });
    } catch (err) {
        await fetchAnim.stop(`❌ Error: ${esc(err.message)}`);
    }
}

// ========== KEYBOARDS ==========
const KB_LANDING = {
    reply_markup: {
        keyboard: [
            [{ text: '🎁 Coba Gratis (Trial)' }, { text: '⭐ Premium' }],
            [{ text: '🔧 File Tools' }, { text: '❓ Bantuan' }]
        ],
        resize_keyboard: true, one_time_keyboard: false
    }
};

const KB_PRE_LOGIN = {
    reply_markup: {
        keyboard: [
            [{ text: '🔑 Login WhatsApp' }],
            [{ text: '📊 Status' }, { text: '👤 Akun Saya' }],
            [{ text: '🔧 File Tools' }],
            [{ text: '⭐ Premium' }, { text: '❓ Bantuan' }]
        ],
        resize_keyboard: true, one_time_keyboard: false
    }
};

const KB_MAIN = {
    reply_markup: {
        keyboard: [
            [{ text: '📋 Daftar Grup' }, { text: '🎯 Pilih Grup' }],
            [{ text: '➕ Buat Grup WA' }, { text: '📥 Import VCF' }],
            [{ text: '🔴 Kick Menu' }, { text: '📊 Status' }],
            [{ text: '🔧 File Tools' }, { text: '🚪 Logout WhatsApp' }]
        ],
        resize_keyboard: true, one_time_keyboard: false
    }
};

const KB_ADMIN_PRE = {
    reply_markup: {
        keyboard: [
            [{ text: '🔑 Login WhatsApp' }],
            [{ text: '📋 Pending Payment' }, { text: '👥 User List' }],
            [{ text: '🔧 File Tools' }, { text: '📁 Admin File Manager' }],
            [{ text: '📊 Status' }, { text: '❓ Bantuan' }]
        ],
        resize_keyboard: true, one_time_keyboard: false
    }
};

const KB_ADMIN_MAIN = {
    reply_markup: {
        keyboard: [
            [{ text: '📋 Daftar Grup' }, { text: '🎯 Pilih Grup' }],
            [{ text: '➕ Buat Grup WA' }, { text: '📥 Import VCF' }],
            [{ text: '🔴 Kick Menu' }, { text: '📊 Status' }],
            [{ text: '🔧 File Tools' }, { text: '📁 Admin File Manager' }],
            [{ text: '📋 Pending Payment' }, { text: '👥 User List' }],
            [{ text: '🚪 Logout WhatsApp' }]
        ],
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

async function requireAccess(ctx, next) {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (isAdmin(userId)) return next();
    const status = await getUserStatus(userId);
    if (status === 'regular' || status === 'trial') return next();
    if (status === 'expired')
        return safeReply(ctx, `╔${DIVIDER}╗\n║  AKSES BERAKHIR\n╚${DIVIDER}╝\n\nPaket lo sudah expired.\nPerpanjang sekarang!\n\nKetik /beli untuk lihat paket.`, { ...KB_LANDING });
    if (status === 'trial_expired')
        return safeReply(ctx, `╔${DIVIDER}╗\n║  TRIAL BERAKHIR\n╚${DIVIDER}╝\n\nMasa trial lo sudah habis.\nUpgrade ke paket reguler!\n\nKetik /beli untuk lihat paket.`, { ...KB_LANDING });
    await safeReply(ctx, `╔${DIVIDER}╗\n║  AKSES DITOLAK\n╚${DIVIDER}╝\n\nBot ini berbayar.\n\n🎁 Coba gratis ${TRIAL_DURATION_HOURS} jam → tekan tombol Coba Gratis\n💳 Atau langsung beli paket → tekan ⭐ Premium`, { ...KB_LANDING });
}

// ========================================
// ===== FILE TOOLS — UPGRADED v7.0.0 =====
// ========================================
// Semua fungsi konversi kini tanya dulu: Default atau Custom nama?
// Pecah VCF: user bebas ketik jumlah (tidak ada batasan tombol)

// Helper: setelah file dikumpulkan, tanya mode penamaan
async function askNamingMode(ctx, userId, stateUpdate) {
    // Simpan state baru
    setState(userId, { ...getState(userId), ...stateUpdate });
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📂 Default (nama dari file)', `naming_default_${userId}`)],
        [Markup.button.callback('✏️ Custom (nama manual)', `naming_custom_${userId}`)],
    ]);
    await safeReply(ctx, `📝 *Pilih mode penamaan output:*\n\n📂 *Default* — nama file output sama dengan nama file asli\n✏️ *Custom* — kamu tentukan sendiri nama outputnya`, { ...keyboard });
}

// --- 1. TXT to VCF ---
async function handleCvTxtToVcfStart(ctx, userId) {
    setState(userId, { mode: 'cv_txt_to_vcf', files: [], fileNames: [], collecting: true });
    await safeReply(ctx, `📥 *Mengumpulkan file TXT...*\n\nSetelah selesai mengirimkan File silahkan tekan /done untuk melanjutkan`);
}

async function handleCvTxtToVcfFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.txt';
    if (!fname.toLowerCase().endsWith('.txt')) return safeReply(ctx, '⚠️ Hanya file .txt yang diterima.');
    if (state.files.length >= MAX_FILES_PER_BATCH) return safeReply(ctx, `❌ Maksimal ${MAX_FILES_PER_BATCH} file per batch.`);
    try {
        const buffer      = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
        const textContent = buffer.toString('utf-8');
        state.files.push({ name: fname, content: textContent });
        state.fileNames = state.fileNames || [];
        state.fileNames.push(fname);
        setState(userId, state);
    } catch (err) {
        log('ERROR', 'CvTxtToVcf', err.message, err);
        await safeReply(ctx, `❌ Error membaca file: ${err.message}`);
    }
}

async function finalizeCvTxtToVcf(ctx, userId, state) {
    if (state.files.length === 0) {
        clearState(userId);
        return safeReply(ctx, '❌ Tidak ada file yang dikumpulkan.');
    }
    await askNamingMode(ctx, userId, { phase: 'naming', pendingFinalize: 'cv_txt_to_vcf' });
}

async function executeCvTxtToVcf(ctx, userId, state, customName = null) {
    try {
        const fileList = state.fileNames.map((f, i) => `${i+1}. ${f}`).join('\n');
        await safeReply(ctx, `📥 *${state.files.length} file diterima:*\n\n${fileList}\n\n${'─'.repeat(30)}\n⏳ Memproses konversi...`);
        const results = [];
        for (let idx = 0; idx < state.files.length; idx++) {
            const file     = state.files[idx];
            const contacts = parseTxtLines(file.content);
            let outName;
            if (customName) {
                outName = state.files.length === 1 ? customName : `${customName}_${idx + 1}`;
            } else {
                outName = file.name.replace(/\.txt$/i, '');
            }
            const vcfContent = generateVCF(contacts);
            await sendFile(ctx, Buffer.from(vcfContent, 'utf-8'), `${outName}.vcf`, `✅ ${file.name} → ${outName}.vcf (${contacts.length} kontak)`);
            results.push(`✅ ${file.name} → ${outName}.vcf (${contacts.length} kontak)`);
        }
        await safeReply(ctx, `📦 *HASIL KONVERSI*\n\n${results.join('\n')}\n\n📊 Total: ${state.files.length} file diproses`);
    } catch (err) {
        log('ERROR', 'CvTxtToVcf', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
    } finally {
        clearState(userId);
    }
}

// --- 2. VCF to TXT ---
async function handleCvVcfToTxtStart(ctx, userId) {
    setState(userId, { mode: 'cv_vcf_to_txt', files: [], fileNames: [], collecting: true });
    await safeReply(ctx, `📥 *Mengumpulkan file VCF...*\n\nSetelah selesai mengirimkan File silahkan tekan /done untuk melanjutkan`);
}

async function handleCvVcfToTxtFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.vcf';
    if (!fname.toLowerCase().endsWith('.vcf')) return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    if (state.files.length >= MAX_FILES_PER_BATCH) return safeReply(ctx, `❌ Maksimal ${MAX_FILES_PER_BATCH} file per batch.`);
    try {
        const buffer  = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
        const vcfText = buffer.toString('utf-8');
        state.files.push({ name: fname, content: vcfText });
        state.fileNames = state.fileNames || [];
        state.fileNames.push(fname);
        setState(userId, state);
    } catch (err) {
        log('ERROR', 'CvVcfToTxt', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
    }
}

async function finalizeCvVcfToTxt(ctx, userId, state) {
    if (state.files.length === 0) {
        clearState(userId);
        return safeReply(ctx, '❌ Tidak ada file yang dikumpulkan.');
    }
    await askNamingMode(ctx, userId, { phase: 'naming', pendingFinalize: 'cv_vcf_to_txt' });
}

async function executeCvVcfToTxt(ctx, userId, state, customName = null) {
    try {
        const fileList = state.fileNames.map((f, i) => `${i+1}. ${f}`).join('\n');
        await safeReply(ctx, `📥 *${state.files.length} file diterima:*\n\n${fileList}\n\n${'─'.repeat(30)}\n⏳ Memproses konversi...`);
        const results = [];
        for (let idx = 0; idx < state.files.length; idx++) {
            const file     = state.files[idx];
            const contacts = parseVCF(file.content);
            let outName;
            if (customName) {
                outName = state.files.length === 1 ? customName : `${customName}_${idx + 1}`;
            } else {
                outName = file.name.replace(/\.vcf$/i, '');
            }
            const txtContent = contacts.map(c => c.phone).join('\n');
            await sendFile(ctx, Buffer.from(txtContent, 'utf-8'), `${outName}.txt`, `✅ ${file.name} → ${outName}.txt (${contacts.length} nomor)`);
            results.push(`✅ ${file.name} → ${outName}.txt (${contacts.length} nomor)`);
        }
        await safeReply(ctx, `📦 *HASIL KONVERSI*\n\n${results.join('\n')}\n\n📊 Total: ${state.files.length} file diproses`);
    } catch (err) {
        log('ERROR', 'CvVcfToTxt', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
    } finally {
        clearState(userId);
    }
}

// --- 3. XLSX to VCF ---
async function handleCvXlsxToVcfStart(ctx, userId) {
    if (!XLSX) return safeReply(ctx, '❌ Fitur XLSX → VCF memerlukan package xlsx.\n\nAdmin perlu install:\n`npm install xlsx`');
    setState(userId, { mode: 'cv_xlsx_to_vcf', waiting: true });
    await safeReply(ctx, `📊 *XLSX → VCF*\n\nSilakan kirim file .xlsx.\nBot akan memindai semua cell dan mengambil nomor telepon yang valid.\n\nKetik /batal untuk membatalkan.`);
}

async function handleCvXlsxToVcfFile(ctx, userId, state, doc) {
    if (!XLSX) return safeReply(ctx, '❌ Package xlsx tidak terinstall. Hubungi admin.');
    const fname = doc.file_name || 'file.xlsx';
    if (!fname.toLowerCase().endsWith('.xlsx')) return safeReply(ctx, '⚠️ Hanya file .xlsx yang diterima.');
    try {
        const buffer   = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        let allNumbers = [], totalCells = 0;
        for (const sheetName of workbook.SheetNames) {
            const sheet = workbook.Sheets[sheetName];
            const data  = XLSX.utils.sheet_to_json(sheet, { header: 1 });
            for (const row of data) {
                if (!row) continue;
                for (const cell of row) {
                    totalCells++;
                    if (cell !== null && cell !== undefined && isPhoneNumber(String(cell))) {
                        const norm = normalizePhone(String(cell));
                        if (norm) allNumbers.push(norm);
                    }
                }
            }
        }
        const seen = new Set();
        const uniqueNumbers = [];
        let dupCount = 0;
        for (const num of allNumbers) {
            if (seen.has(num)) { dupCount++; continue; }
            seen.add(num);
            uniqueNumbers.push(num);
        }
        // Simpan data untuk ditanya penamaan
        setState(userId, {
            ...state,
            phase: 'naming',
            pendingFinalize: 'cv_xlsx_to_vcf',
            xlsxData: { uniqueNumbers, totalCells, dupCount, allCount: allNumbers.length },
            origFileName: fname,
            waiting: false
        });
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📂 Default (nama dari file)', `naming_default_${userId}`)],
            [Markup.button.callback('✏️ Custom (nama manual)', `naming_custom_${userId}`)],
        ]);
        await safeReply(ctx, `📊 *Scan selesai!*\n\n📋 File : ${fname}\n🔢 Cell dipindai : ${totalCells}\n📞 Nomor ditemukan : ${allNumbers.length}\n🚫 Duplikat : ${dupCount}\n✅ Kontak unik : ${uniqueNumbers.length}\n\n📝 *Pilih mode penamaan output:*`, { ...keyboard });
    } catch (err) {
        log('ERROR', 'CvXlsxToVcf', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
        clearState(userId);
    }
}

async function executeCvXlsxToVcf(ctx, userId, state, customName = null) {
    try {
        const { uniqueNumbers, totalCells, dupCount, allCount } = state.xlsxData;
        const fname    = state.origFileName;
        const contacts = uniqueNumbers.map(num => ({ name: `Kontak ${num}`, phone: num }));
        const outName  = customName || fname.replace(/\.xlsx$/i, '');
        const vcfContent = generateVCF(contacts);
        const infoText = `📊 HASIL KONVERSI XLSX → VCF\n${'─'.repeat(30)}\n📋 File : ${fname}\n🔢 Cell dipindai : ${totalCells}\n📞 Nomor ditemukan : ${allCount}\n🚫 Duplikat : ${dupCount}\n✅ Kontak unik : ${uniqueNumbers.length}`;
        await sendFile(ctx, Buffer.from(vcfContent, 'utf-8'), `${outName}.vcf`, infoText);
    } catch (err) {
        log('ERROR', 'CvXlsxToVcf', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
    } finally {
        clearState(userId);
    }
}

// --- 4. TXT2VCF Auto ---
async function handleTxt2VcfStart(ctx, userId) {
    setState(userId, { mode: 'txt2vcf', waiting: true });
    await safeReply(ctx, `📝 *TXT2VCF Auto-Detect*\n\nKirim file .txt untuk langsung dikonversi menjadi VCF.\n\nFormat yang didukung:\n• Nomor di depan: \`08123 Nama\`\n• Nama di depan: \`Nama 08123\`\n• Separator: \`Nama|08123\` atau \`Nama,08123\`\n• Hanya nomor: \`081234567890\`\n\nKetik /batal untuk membatalkan.`);
}

async function handleTxt2VcfFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.txt';
    if (!fname.toLowerCase().endsWith('.txt')) return safeReply(ctx, '⚠️ Hanya file .txt yang diterima.');
    try {
        const buffer   = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
        const contacts = parseTxtLines(buffer.toString('utf-8'));
        if (contacts.length === 0) return safeReply(ctx, '❌ Tidak ada nomor telepon valid yang ditemukan.');

        setState(userId, { ...state, phase: 'naming', pendingFinalize: 'txt2vcf', contacts, origFileName: fname, waiting: false });
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📂 Default (nama dari file)', `naming_default_${userId}`)],
            [Markup.button.callback('✏️ Custom (nama manual)', `naming_custom_${userId}`)],
        ]);
        await safeReply(ctx, `📝 *${fname}* — ${contacts.length} kontak ditemukan.\n\n📝 *Pilih mode penamaan output:*`, { ...keyboard });
    } catch (err) {
        log('ERROR', 'Txt2Vcf', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
        clearState(userId);
    }
}

async function executeTxt2Vcf(ctx, userId, state, customName = null) {
    try {
        const fname    = state.origFileName;
        const outName  = customName || fname.replace(/\.txt$/i, '');
        const vcfContent = generateVCF(state.contacts);
        await sendFile(ctx, Buffer.from(vcfContent, 'utf-8'), `${outName}.vcf`, `✅ ${fname} → ${outName}.vcf\n👤 ${state.contacts.length} kontak unik`);
    } catch (err) {
        log('ERROR', 'Txt2Vcf', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
    } finally {
        clearState(userId);
    }
}

// --- 5. Gabung TXT ---
async function handleGabungTxtStart(ctx, userId) {
    setState(userId, { mode: 'gabungtxt', files: [], fileNames: [], collecting: true });
    await safeReply(ctx, `📥 *Mengumpulkan file TXT...*\n\nSetelah selesai mengirimkan File silahkan tekan /done untuk melanjutkan`);
}

async function handleGabungTxtFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.txt';
    if (!fname.toLowerCase().endsWith('.txt')) return safeReply(ctx, '⚠️ Hanya file .txt yang diterima.');
    if (state.files.length >= MAX_FILES_PER_BATCH) return safeReply(ctx, `❌ Maksimal ${MAX_FILES_PER_BATCH} file per batch.`);
    try {
        const buffer      = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
        const textContent = buffer.toString('utf-8');
        state.files.push({ name: fname, content: textContent });
        state.fileNames = state.fileNames || [];
        state.fileNames.push(fname);
        setState(userId, state);
    } catch (err) {
        log('ERROR', 'GabungTxt', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
    }
}

async function finalizeGabungTxt(ctx, userId, state) {
    if (state.files.length < 2) {
        clearState(userId);
        return safeReply(ctx, '❌ Minimal 2 file untuk digabung.');
    }
    await askNamingMode(ctx, userId, { phase: 'naming', pendingFinalize: 'gabungtxt' });
}

async function executeGabungTxt(ctx, userId, state, customName = null) {
    try {
        const fileList = state.fileNames.map((f, i) => `${i+1}. ${f}`).join('\n');
        await safeReply(ctx, `📥 *${state.files.length} file diterima:*\n\n${fileList}\n\n${'─'.repeat(30)}\n⏳ Memproses penggabungan...`);
        const allLines = [];
        let totalLines = 0;
        for (const file of state.files) {
            const lines = file.content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            totalLines += lines.length;
            allLines.push(...lines);
        }
        const seenLines = new Set();
        const merged    = [];
        for (const line of allLines) {
            const normalized = normalizePhone(line) || line.toLowerCase();
            if (!normalized || seenLines.has(normalized)) continue;
            seenLines.add(normalized);
            merged.push(line);
        }
        const dupCount  = allLines.length - merged.length;
        const outName   = customName || 'gabungan';
        const infoText  = `📄 HASIL GABUNG TXT\n${'─'.repeat(30)}\n📁 File digabung : ${state.files.length}\n📝 Total baris : ${totalLines}\n🚫 Duplikat : ${dupCount}\n✅ Baris unik : ${merged.length}`;
        await sendFile(ctx, Buffer.from(merged.join('\n'), 'utf-8'), `${outName}.txt`, infoText);
    } catch (err) {
        log('ERROR', 'GabungTxt', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
    } finally {
        clearState(userId);
    }
}

// --- 6. Gabung VCF ---
async function handleGabungVcfStart(ctx, userId) {
    setState(userId, { mode: 'gabungvcf', files: [], fileNames: [], collecting: true });
    await safeReply(ctx, `📥 *Mengumpulkan file VCF...*\n\nSetelah selesai mengirimkan File silahkan tekan /done untuk melanjutkan`);
}

async function handleGabungVcfFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.vcf';
    if (!fname.toLowerCase().endsWith('.vcf')) return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    if (state.files.length >= MAX_FILES_PER_BATCH) return safeReply(ctx, `❌ Maksimal ${MAX_FILES_PER_BATCH} file per batch.`);
    try {
        const buffer  = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
        const vcfText = buffer.toString('utf-8');
        state.files.push({ name: fname, content: vcfText });
        state.fileNames = state.fileNames || [];
        state.fileNames.push(fname);
        setState(userId, state);
    } catch (err) {
        log('ERROR', 'GabungVcf', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
    }
}

async function finalizeGabungVcf(ctx, userId, state) {
    if (state.files.length < 2) {
        clearState(userId);
        return safeReply(ctx, '❌ Minimal 2 file untuk digabung.');
    }
    await askNamingMode(ctx, userId, { phase: 'naming', pendingFinalize: 'gabungvcf' });
}

async function executeGabungVcf(ctx, userId, state, customName = null) {
    try {
        const fileList = state.fileNames.map((f, i) => `${i+1}. ${f}`).join('\n');
        await safeReply(ctx, `📥 *${state.files.length} file diterima:*\n\n${fileList}\n\n${'─'.repeat(30)}\n⏳ Memproses penggabungan...`);
        const allContacts = [];
        const seen        = new Set();
        let totalContacts = 0, dupCount = 0;
        for (const file of state.files) {
            const contacts = parseVCF(file.content);
            totalContacts += contacts.length;
            for (const c of contacts) {
                if (seen.has(c.phone)) { dupCount++; continue; }
                seen.add(c.phone);
                allContacts.push(c);
            }
        }
        const outName  = customName || 'gabungan';
        const infoText = `📄 HASIL GABUNG VCF\n${'─'.repeat(30)}\n📁 File digabung : ${state.files.length}\n📝 Total kontak : ${totalContacts}\n🚫 Duplikat : ${dupCount}\n✅ Kontak unik : ${allContacts.length}`;
        await sendFile(ctx, Buffer.from(generateVCF(allContacts), 'utf-8'), `${outName}.vcf`, infoText);
    } catch (err) {
        log('ERROR', 'GabungVcf', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
    } finally {
        clearState(userId);
    }
}

// --- 7. Pecah VCF (bagian) — UPGRADED: user ketik jumlah bebas ---
async function handlePecahFileStart(ctx, userId) {
    setState(userId, { mode: 'pecahfile', waiting: true });
    await safeReply(ctx, `✂️ *PECAH VCF (BAGIAN)*\n\nSilakan kirim file .vcf yang ingin dipecah.\n\nKetik /batal untuk membatalkan.`);
}

async function handlePecahFileVcf(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.vcf';
    if (!fname.toLowerCase().endsWith('.vcf')) return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    try {
        const buffer   = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
        const vcfText  = buffer.toString('utf-8');
        const contacts = parseVCF(vcfText);
        if (contacts.length < 2) return safeReply(ctx, '❌ Minimal 2 kontak untuk dipecah.');
        const baseName = fname.replace(/\.vcf$/i, '');
        setState(userId, { mode: 'pecahfile', phase: 'choose_parts', contacts, baseName });
        await safeReply(ctx, `📋 *File:* ${fname}\n📊 *Total kontak:* ${contacts.length}\n\n✏️ *Ketik jumlah bagian yang kamu inginkan:*\nContoh: \`4\` (artinya pecah jadi 4 bagian sama rata)\n\nTidak ada batasan jumlah — sesuaikan kebutuhanmu.\nKetik /batal untuk membatalkan.`);
    } catch (err) {
        log('ERROR', 'PecahFile', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
        clearState(userId);
    }
}

// --- 8. Pecah VCF (jumlah kontak) — UPGRADED: user ketik bebas ---
async function handlePecahCtcStart(ctx, userId) {
    setState(userId, { mode: 'pecahctc', phase: 'waiting_file_request' });
    await safeReply(ctx, `✂️ *PECAH VCF (PER JUMLAH KONTAK)*\n\nSilakan kirim file .vcf yang ingin dipecah.\n\nKetik /batal untuk membatalkan.`);
}

async function handlePecahCtcFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.vcf';
    if (!fname.toLowerCase().endsWith('.vcf')) return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    try {
        const buffer   = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
        const vcfText  = buffer.toString('utf-8');
        const contacts = parseVCF(vcfText);
        if (contacts.length === 0) return safeReply(ctx, '❌ Tidak ada kontak valid.');
        const baseName = fname.replace(/\.vcf$/i, '');
        setState(userId, { mode: 'pecahctc', phase: 'waiting_count', contacts, baseName, origFileName: fname });
        await safeReply(ctx, `📋 *File:* ${fname}\n📊 *Total kontak:* ${contacts.length}\n\n✏️ *Ketik jumlah kontak per file:*\nContoh: \`100\` (artinya setiap file berisi maks 100 kontak)\n\nTidak ada batasan — kamu bisa ketik berapa saja.\nKetik /batal untuk membatalkan.`);
    } catch (err) {
        log('ERROR', 'PecahCtc', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
        clearState(userId);
    }
}

async function executePecahCtc(ctx, userId, state, countPerFile, customName = null) {
    try {
        const contacts   = state.contacts;
        const baseName   = customName || state.baseName;
        const totalParts = Math.ceil(contacts.length / countPerFile);
        await safeReply(ctx, `📋 *Total kontak:* ${contacts.length}\n📏 *Per file:* ${countPerFile} kontak\n📁 *Menjadi:* ${totalParts} bagian\n\n⏳ Memproses...`);
        for (let i = 0; i < totalParts; i++) {
            const partContacts = contacts.slice(i * countPerFile, (i + 1) * countPerFile);
            const vcfContent   = generateVCF(partContacts);
            const partNum      = String(i + 1).padStart(3, '0');
            await sendFile(ctx, Buffer.from(vcfContent, 'utf-8'), `${baseName}_${partNum}.vcf`, `📄 Bagian ${i + 1}/${totalParts}: ${partContacts.length} kontak`);
        }
        await safeReply(ctx, `✅ File berhasil dipecah menjadi ${totalParts} bagian\n📋 Total kontak: ${contacts.length}\n📏 Per file: ${countPerFile} kontak`);
    } catch (err) {
        log('ERROR', 'PecahCtc', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
    } finally {
        clearState(userId);
    }
}

// --- 9. Tambah Kontak ---
async function handleAddCtcStart(ctx, userId) {
    setState(userId, { mode: 'addctc', phase: 'waiting_vcf' });
    await safeReply(ctx, `➕ *TAMBAH KONTAK VCF*\n\nSilakan kirim file .vcf yang ingin ditambahi kontak.\n\nKetik /batal untuk membatalkan.`);
}

async function handleAddCtcFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.vcf';
    if (!fname.toLowerCase().endsWith('.vcf')) return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    try {
        const buffer   = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
        const contacts = parseVCF(buffer.toString('utf-8'));
        if (contacts.length === 0) return safeReply(ctx, '❌ Tidak ada kontak valid dalam file.');
        setState(userId, { mode: 'addctc', phase: 'waiting_contacts', existingContacts: contacts, fileName: fname });
        await safeReply(ctx, `📋 *File:* ${fname}\n👤 *Kontak saat ini:* ${contacts.length}\n\n${'─'.repeat(30)}\nSilakan kirim kontak tambahan dalam format teks (satu per baris):\n\nContoh:\nNama Baru|081234567890\n081987654321\n+628123456789|Nama Lain\n\n${'─'.repeat(30)}\nKetik /done jika selesai atau /batal untuk batal.`);
    } catch (err) {
        log('ERROR', 'AddCtc', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
        clearState(userId);
    }
}

// --- 10. Hapus Kontak ---
async function handleDelCtcStart(ctx, userId) {
    setState(userId, { mode: 'delctc', phase: 'waiting_vcf' });
    await safeReply(ctx, `➖ *HAPUS KONTAK VCF*\n\nSilakan kirim file .vcf yang ingin dihapus kontaknya.\n\nKetik /batal untuk membatalkan.`);
}

async function handleDelCtcFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.vcf';
    if (!fname.toLowerCase().endsWith('.vcf')) return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    try {
        const buffer   = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
        const contacts = parseVCF(buffer.toString('utf-8'));
        if (contacts.length === 0) return safeReply(ctx, '❌ Tidak ada kontak valid dalam file.');
        let preview = `📋 *DAFTAR KONTAK*\n${'─'.repeat(30)}\n📇 *File:* ${fname}\n👤 *Total:* ${contacts.length} kontak\n\n`;
        const maxShow = Math.min(30, contacts.length);
        for (let i = 0; i < maxShow; i++) {
            const c = contacts[i];
            preview += `${i + 1}. ${c.name} → ${c.phone}\n`;
        }
        if (contacts.length > 30) preview += `\n... dan ${contacts.length - 30} kontak lainnya`;
        preview += `\n${'─'.repeat(30)}\nKetik nomor urut yang ingin dihapus:\nFormat: 1,3,5-8,10\n\nKetik /done jika selesai atau /batal untuk batal.`;
        setState(userId, { mode: 'delctc', phase: 'waiting_input', contacts, fileName: fname });
        await safeReply(ctx, preview);
    } catch (err) {
        log('ERROR', 'DelCtc', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
        clearState(userId);
    }
}

// --- 11. Hitung Kontak ---
async function handleHitungCtcStart(ctx, userId) {
    setState(userId, { mode: 'hitungctc', waiting: true });
    await safeReply(ctx, `🔢 *HITUNG KONTAK VCF*\n\nSilakan kirim file .vcf yang ingin dihitung.\n\nKetik /batal untuk membatalkan.`);
}

async function handleHitungCtcFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.vcf';
    if (!fname.toLowerCase().endsWith('.vcf')) return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    try {
        const buffer   = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
        const contacts = parseVCF(buffer.toString('utf-8'));
        let withName = 0, withoutName = 0, dupCount = 0;
        const seenPhone = new Set();
        for (const c of contacts) {
            if (c.name && c.name !== 'Tanpa Nama') withName++;
            else withoutName++;
            if (seenPhone.has(c.phone)) dupCount++;
            else seenPhone.add(c.phone);
        }
        await safeReply(ctx, `🔢 *HASIL HITUNG KONTAK VCF*\n${'─'.repeat(30)}\n📇 File : ${fname}\n👤 Total kontak : ${contacts.length}\n✅ Punya nama : ${withName}\n❓ Tanpa nama : ${withoutName}\n📞 Nomor unik : ${seenPhone.size}\n🚫 Nomor duplikat : ${dupCount}`);
        clearState(userId);
    } catch (err) {
        log('ERROR', 'HitungCtc', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
        clearState(userId);
    }
}

// --- 12. Rename Kontak ---
async function handleRenamectcStart(ctx, userId) {
    setState(userId, { mode: 'renamectc', phase: 'waiting_vcf' });
    await safeReply(ctx, `✏️ *RENAME KONTAK VCF*\n\nSilakan kirim file .vcf yang ingin direname kontaknya.\n\nKetik /batal untuk membatalkan.`);
}

async function handleRenamectcFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.vcf';
    if (!fname.toLowerCase().endsWith('.vcf')) return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    try {
        const buffer   = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
        const contacts = parseVCF(buffer.toString('utf-8'));
        if (contacts.length === 0) return safeReply(ctx, '❌ Tidak ada kontak valid dalam file.');
        let preview = `📋 *PREVIEW KONTAK*\n${'─'.repeat(30)}\n📇 *File:* ${fname}\n👤 *Total:* ${contacts.length} kontak\n\n`;
        contacts.slice(0, 5).forEach((c, i) => { preview += `${i + 1}. ${c.name} → ${c.phone}\n`; });
        if (contacts.length > 5) preview += `\n... dan ${contacts.length - 5} kontak lainnya`;
        preview += `\n${'─'.repeat(30)}\nPilih metode rename:`;
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('➕ Tambah Prefix', 'rename_prefix')],
            [Markup.button.callback('➕ Tambah Suffix', 'rename_suffix')],
            [Markup.button.callback('🔢 Ganti + Nomor Urut', 'rename_numbered')],
            [Markup.button.callback('❌ Batal', 'rename_cancel')],
        ]);
        setState(userId, { mode: 'renamectc', phase: 'choose_method', contacts, fileName: fname });
        await safeReply(ctx, preview, { ...keyboard });
    } catch (err) {
        log('ERROR', 'Renamectc', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
        clearState(userId);
    }
}

// --- 13. Rename File ---
async function handleRenameFileStart(ctx, userId, newName) {
    if (!newName || newName.trim().length === 0) return safeReply(ctx, `Format: /renamefile [nama_baru]\n\nContoh: /renamefile arisan_baru`);
    const invalidChars = /[\/\\:*?"<>|]/;
    if (invalidChars.test(newName)) return safeReply(ctx, `❌ Nama file tidak boleh mengandung karakter: / \\ : * ? " < > |`);
    if (newName.length > 100) return safeReply(ctx, `❌ Nama file maksimal 100 karakter.`);
    setState(userId, { mode: 'renamefile', newName: newName.trim(), waiting: true });
    await safeReply(ctx, `✏️ *RENAME FILE*\n\nSilakan kirim file yang ingin diganti namanya.\nNama baru: ${newName.trim()} (ekstensi akan dipertahankan)\n\nKetik /batal untuk membatalkan.`);
}

async function handleRenameFile(ctx, userId, state, doc) {
    const fname       = doc.file_name || 'file';
    const ext         = path.extname(fname) || '';
    const newFileName = `${state.newName}${ext}`;
    try {
        const buffer = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
        await sendFile(ctx, buffer, safeFilename(newFileName), `✅ File: ${fname}\n→ ${newFileName}`);
        clearState(userId);
    } catch (err) {
        log('ERROR', 'RenameFile', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
        clearState(userId);
    }
}

// --- 14. Pesan ke TXT ---
async function handleTotxtStart(ctx, userId) {
    setState(userId, { mode: 'totxt', messages: [], active: true });
    await safeReply(ctx, `📄 *PESAN KE TXT*\n\nMode pengumpulan pesan aktif.\nSetiap pesan teks yang kamu kirim akan disimpan.\n\nKetik /done untuk generate file TXT.\n\nMaks 500 pesan.\n\nKetik /batal untuk membatalkan.`);
}

// --- 15. Rekap Group ---
async function handleRekapGroup(ctx, userId) {
    setState(userId, { mode: 'rekapgroup', phase: 'waiting_photo' });
    await safeReply(ctx, `📸 *Rekap Grup*\n\nSilakan kirim foto/screenshot info grup WhatsApp.\nAtau kirim foto dengan caption format:\nNamaGrup|JumlahMember\n\nKetik /batal untuk membatalkan.`);
}

// --- 16. Admin File Manager ---
async function handleCvAdminFile(ctx, userId) {
    if (!isAdmin(userId)) return safeReply(ctx, '⛔ Akses ditolak. Hanya admin.');
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📤 Upload File', 'adminfile_upload')],
        [Markup.button.callback('📂 Lihat File', 'adminfile_list')],
        [Markup.button.callback('🗑️ Hapus File', 'adminfile_delete')],
        [Markup.button.callback('📥 Download File', 'adminfile_download')],
    ]);
    await safeReply(ctx, `📁 *ADMIN FILE MANAGER*\n\nPilih aksi:`, { ...keyboard });
}

async function handleAdminFileUpload(ctx, userId) {
    setState(userId, { mode: 'cvadminfile_upload', waiting: true });
    await safeReply(ctx, `📤 Silakan kirim file yang ingin diupload.\n\nKetik /batal untuk membatalkan.`);
}

async function handleAdminFileUploadFile(ctx, userId, state, doc) {
    const fname = safeFilename(doc.file_name || 'unnamed_file');
    try {
        const existingFiles = fs.readdirSync(ADMIN_FILES_DIR);
        if (existingFiles.length >= MAX_ADMIN_FILES) {
            clearState(userId);
            return safeReply(ctx, `❌ Batas penyimpanan admin (${MAX_ADMIN_FILES} file) tercapai.`);
        }
    } catch (_) {}
    try {
        const buffer   = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
        let finalPath  = path.join(ADMIN_FILES_DIR, fname);
        if (fs.existsSync(finalPath)) {
            const base    = path.parse(fname).name;
            const ext     = path.parse(fname).ext;
            const newName = `${base}_${Date.now()}${ext}`;
            finalPath     = path.join(ADMIN_FILES_DIR, newName);
            fs.writeFileSync(finalPath, buffer);
            await safeReply(ctx, `✅ File diupload sebagai: ${newName}`);
        } else {
            fs.writeFileSync(finalPath, buffer);
            await safeReply(ctx, `✅ File berhasil diupload: ${fname}`);
        }
        clearState(userId);
    } catch (err) {
        log('ERROR', 'AdminFile', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
        clearState(userId);
    }
}

// ========================================
// ===== NAMING MODE INLINE HANDLERS ======
// ========================================
// Dipanggil saat user memilih Default atau Custom naming

tgBot.action(/^naming_default_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery('✅ Menggunakan nama default');
    const userId = parseInt(ctx.match[1]);
    // Validasi bahwa ini user yang sama
    if (ctx.from.id !== userId) return ctx.answerCbQuery('⛔ Bukan milikmu.');
    const state = getState(userId);
    if (!state) return ctx.editMessageText('❌ Session expired. Ulangi proses.');
    await ctx.editMessageText('✅ Menggunakan nama default dari file...');
    await dispatchNaming(ctx, userId, state, null);
});

tgBot.action(/^naming_custom_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery('✏️ Masukkan nama custom');
    const userId = parseInt(ctx.match[1]);
    if (ctx.from.id !== userId) return ctx.answerCbQuery('⛔ Bukan milikmu.');
    const state = getState(userId);
    if (!state) return ctx.editMessageText('❌ Session expired. Ulangi proses.');
    setState(userId, { ...state, phase: 'waiting_custom_name' });
    await ctx.editMessageText('✏️ Ketik nama output yang kamu inginkan:\n\n_Contoh: kontak_baru_ (tanpa ekstensi)\n\nKetik /batal untuk membatalkan.');
});

async function dispatchNaming(ctx, userId, state, customName) {
    switch (state.pendingFinalize) {
        case 'cv_txt_to_vcf': return executeCvTxtToVcf(ctx, userId, state, customName);
        case 'cv_vcf_to_txt': return executeCvVcfToTxt(ctx, userId, state, customName);
        case 'cv_xlsx_to_vcf': return executeCvXlsxToVcf(ctx, userId, state, customName);
        case 'txt2vcf': return executeTxt2Vcf(ctx, userId, state, customName);
        case 'gabungtxt': return executeGabungTxt(ctx, userId, state, customName);
        case 'gabungvcf': return executeGabungVcf(ctx, userId, state, customName);
        case 'pecahctc_naming': return executePecahCtc(ctx, userId, state, state.countPerFile, customName);
        default:
            clearState(userId);
            await safeReply(ctx, '❌ Unknown operation. State dihapus.');
    }
}

// ==========================================
// ========== MIDDLEWARE STATE TEXT =========
// ==========================================
tgBot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !ctx.message?.text) return next();
    const state = getState(userId);
    if (!state) return next();

    // Waiting custom name input
    if (state.phase === 'waiting_custom_name' && !ctx.message.text.startsWith('/')) {
        const customName = ctx.message.text.trim().replace(/[\/\\:*?"<>|]/g, '_').substring(0, 100);
        if (!customName) return safeReply(ctx, '❌ Nama tidak valid. Coba lagi atau ketik /batal.');
        await safeReply(ctx, `✅ Nama output: *${customName}*\n\n⏳ Memproses...`);
        await dispatchNaming(ctx, userId, state, customName);
        return;
    }

    // Pecah VCF: waiting jumlah bagian (text input)
    if (state.mode === 'pecahfile' && state.phase === 'choose_parts' && !ctx.message.text.startsWith('/')) {
        const parts = parseInt(ctx.message.text.trim());
        if (isNaN(parts) || parts < 2) return safeReply(ctx, '❌ Masukkan angka minimal 2. Contoh: `4`');
        if (parts > state.contacts.length) return safeReply(ctx, `❌ Jumlah bagian (${parts}) melebihi jumlah kontak (${state.contacts.length}).`);
        const { contacts, baseName } = state;
        // Tanya penamaan
        setState(userId, { ...state, phase: 'naming', pendingFinalize: 'pecahfile_parts', partsCount: parts });
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📂 Default (nama dari file)', `naming_default_${userId}`)],
            [Markup.button.callback('✏️ Custom (nama manual)', `naming_custom_${userId}`)],
        ]);
        await safeReply(ctx, `📊 *${contacts.length} kontak* → *${parts} bagian*\n\n📝 *Pilih mode penamaan output:*`, { ...keyboard });
        return;
    }

    // Pecah VCF: waiting jumlah kontak per file (text input)
    if (state.mode === 'pecahctc' && state.phase === 'waiting_count' && !ctx.message.text.startsWith('/')) {
        const count = parseInt(ctx.message.text.trim());
        if (isNaN(count) || count < 1) return safeReply(ctx, '❌ Masukkan angka minimal 1. Contoh: `100`');
        // Tanya penamaan
        setState(userId, { ...state, phase: 'naming', pendingFinalize: 'pecahctc_naming', countPerFile: count });
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📂 Default (nama dari file)', `naming_default_${userId}`)],
            [Markup.button.callback('✏️ Custom (nama manual)', `naming_custom_${userId}`)],
        ]);
        await safeReply(ctx, `📊 *${state.contacts.length} kontak* → *${count} kontak/file* = *${Math.ceil(state.contacts.length / count)} bagian*\n\n📝 *Pilih mode penamaan output:*`, { ...keyboard });
        return;
    }

    // addctc: waiting_contacts
    if (state.mode === 'addctc' && state.phase === 'waiting_contacts') {
        const input            = ctx.message.text.trim();
        const existingContacts = state.existingContacts;
        const seen             = new Set(existingContacts.map(c => c.phone));
        const lines            = input.split(/\r?\n/);
        let added = 0, skipped = 0;
        const newContacts = [];
        for (const line of lines) {
            const parsed = autoDetectAndParse(line);
            if (!parsed) continue;
            const norm = normalizePhone(parsed.phone);
            if (!norm) continue;
            if (seen.has(norm)) { skipped++; continue; }
            seen.add(norm);
            newContacts.push({ name: parsed.name || `Kontak ${norm}`, phone: norm });
            added++;
        }
        if (newContacts.length === 0) return safeReply(ctx, `⚠️ Tidak ada kontak baru yang valid. Kirim lagi atau ketik /done.`);
        const allContacts = [...existingContacts, ...newContacts];
        const baseName    = state.fileName.replace(/\.vcf$/i, '');
        await sendFile(ctx, Buffer.from(generateVCF(allContacts), 'utf-8'), `${baseName}_updated.vcf`,
            `✅ ${added} kontak ditambahkan\n👤 Total: ${allContacts.length}\n🚫 ${skipped} duplikat dilewati`);
        clearState(userId);
        return;
    }

    // delctc: waiting_input
    if (state.mode === 'delctc' && state.phase === 'waiting_input') {
        const input    = ctx.message.text.trim();
        const contacts = state.contacts;
        try {
            const toDelete = new Set();
            for (const part of input.split(',')) {
                if (part.includes('-')) {
                    const [start, end] = part.split('-').map(n => parseInt(n.trim()));
                    if (isNaN(start) || isNaN(end)) continue;
                    for (let i = Math.max(1, start); i <= Math.min(end, contacts.length); i++) toDelete.add(i);
                } else {
                    const num = parseInt(part.trim());
                    if (!isNaN(num) && num >= 1 && num <= contacts.length) toDelete.add(num);
                }
            }
            if (toDelete.size === 0) return safeReply(ctx, '❌ Format tidak valid. Contoh: 1,3,5-8,10');
            const deletedIndices = Array.from(toDelete).sort((a, b) => b - a);
            const newContacts    = [...contacts];
            for (const idx of deletedIndices) newContacts.splice(idx - 1, 1);
            const baseName = state.fileName.replace(/\.vcf$/i, '');
            await sendFile(ctx, Buffer.from(generateVCF(newContacts), 'utf-8'), `${baseName}_dihapus.vcf`,
                `✅ ${toDelete.size} kontak dihapus\nSisa: ${newContacts.length} kontak`);
            clearState(userId);
        } catch (err) {
            log('ERROR', 'DelCtc', err.message, err);
            await safeReply(ctx, `❌ Error: ${err.message}`);
            clearState(userId);
        }
        return;
    }

    // totxt: collecting messages
    if (state.mode === 'totxt' && state.active) {
        if (ctx.message.text.startsWith('/')) return next();
        if (state.messages.length >= 500) return safeReply(ctx, '⚠️ Sudah 500 pesan. Ketik /done untuk generate file.');
        state.messages.push(ctx.message.text);
        setState(userId, state);
        await safeReply(ctx, `✅ Pesan ke-${state.messages.length} disimpan.`);
        return;
    }

    // renamectc: input text
    if (state.mode === 'renamectc') {
        const input    = ctx.message.text.trim();
        const contacts = state.contacts;
        const baseName = state.fileName.replace(/\.vcf$/i, '');
        if (state.phase === 'input_prefix') {
            try {
                const renamed = contacts.map(c => ({ name: `${input} ${c.name}`, phone: c.phone }));
                await sendFile(ctx, Buffer.from(generateVCF(renamed), 'utf-8'), `${baseName}_prefix.vcf`,
                    `✅ Prefix "${input}" ditambahkan ke ${contacts.length} kontak`);
                clearState(userId);
            } catch (err) { await safeReply(ctx, `❌ Error: ${err.message}`); clearState(userId); }
            return;
        }
        if (state.phase === 'input_suffix') {
            try {
                const renamed = contacts.map(c => ({ name: `${c.name} ${input}`, phone: c.phone }));
                await sendFile(ctx, Buffer.from(generateVCF(renamed), 'utf-8'), `${baseName}_suffix.vcf`,
                    `✅ Suffix "${input}" ditambahkan ke ${contacts.length} kontak`);
                clearState(userId);
            } catch (err) { await safeReply(ctx, `❌ Error: ${err.message}`); clearState(userId); }
            return;
        }
        if (state.phase === 'input_numbered') {
            try {
                const renamed = contacts.map((c, i) => ({ name: `${input} ${i + 1}`, phone: c.phone }));
                await sendFile(ctx, Buffer.from(generateVCF(renamed), 'utf-8'), `${baseName}_numbered.vcf`,
                    `✅ ${contacts.length} kontak di-rename menjadi "${input} 1" s/d "${input} ${contacts.length}"`);
                clearState(userId);
            } catch (err) { await safeReply(ctx, `❌ Error: ${err.message}`); clearState(userId); }
            return;
        }
    }

    // buatgrup: waiting_name
    if (state.mode === 'buatgrup' && state.phase === 'waiting_name') {
        const groupName = ctx.message.text.trim();
        if (!groupName || groupName.length < 1) return safeReply(ctx, '❌ Nama grup tidak boleh kosong.');
        if (groupName.length > 100) return safeReply(ctx, '❌ Nama grup maksimal 100 karakter.');
        setState(userId, { ...state, phase: 'waiting_vcf', groupName });
        await safeReply(ctx, `📋 Nama grup: ${groupName}\n\nSekarang kirim file .vcf berisi kontak yang akan ditambahkan ke grup.\nAtau ketik /buatkosongan untuk buat grup tanpa member.\nKetik /batal untuk membatalkan.`);
        return;
    }

    return next();
});

// ========== DOCUMENT HANDLER ==========
tgBot.on('document', async (ctx) => {
    const userId = ctx.from.id;
    const doc    = ctx.message.document;
    const state  = getState(userId);

    if (state) {
        switch (state.mode) {
            case 'cv_txt_to_vcf':      return handleCvTxtToVcfFile(ctx, userId, state, doc);
            case 'cv_vcf_to_txt':      return handleCvVcfToTxtFile(ctx, userId, state, doc);
            case 'cv_xlsx_to_vcf':     return handleCvXlsxToVcfFile(ctx, userId, state, doc);
            case 'txt2vcf':            return handleTxt2VcfFile(ctx, userId, state, doc);
            case 'gabungtxt':          return handleGabungTxtFile(ctx, userId, state, doc);
            case 'gabungvcf':          return handleGabungVcfFile(ctx, userId, state, doc);
            case 'pecahfile':
                if (state.waiting) return handlePecahFileVcf(ctx, userId, state, doc);
                break;
            case 'pecahctc':
                if (state.phase === 'waiting_file_request') return handlePecahCtcFile(ctx, userId, state, doc);
                break;
            case 'addctc':             return handleAddCtcFile(ctx, userId, state, doc);
            case 'delctc':             return handleDelCtcFile(ctx, userId, state, doc);
            case 'hitungctc':          return handleHitungCtcFile(ctx, userId, state, doc);
            case 'renamectc':          return handleRenamectcFile(ctx, userId, state, doc);
            case 'renamefile':         return handleRenameFile(ctx, userId, state, doc);
            case 'cvadminfile_upload': return handleAdminFileUploadFile(ctx, userId, state, doc);
            case 'buatgrup': {
                if (state.phase === 'waiting_vcf') {
                    const fname = doc.file_name || 'file.vcf';
                    if (!fname.toLowerCase().endsWith('.vcf')) return safeReply(ctx, '⚠️ Hanya file .vcf.');
                    try {
                        const buffer   = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
                        const contacts = parseVCF(buffer.toString('utf-8'));
                        const session  = userSessions.get(userId);
                        if (!session || !session.loggedIn) return safeReply(ctx, '❌ Sesi WA tidak aktif.');
                        await safeReply(ctx, `⏳ Membuat grup "${state.groupName}" dengan ${contacts.length} kontak...`);
                        const phoneList = contacts.map(c => `${c.phone}@s.whatsapp.net`);
                        const groupData = await session.sock.groupCreate(state.groupName, phoneList);
                        await safeReply(ctx, `✅ Grup berhasil dibuat!\n\n📋 Nama: ${groupData.subject}\n👥 Member: ${contacts.length}\n🆔 ID: ${groupData.id}`);
                        clearState(userId);
                    } catch (err) {
                        log('ERROR', 'BuatGrup', err.message, err);
                        await safeReply(ctx, `❌ Gagal buat grup: ${err.message}`);
                        clearState(userId);
                    }
                }
                return;
            }
        }
    }

    // VCF import pending (WA feature)
    const pending = vcfPending.get(userId);
    if (pending && pending.waitingFile) {
        const fname = doc.file_name || '';
        if (!fname.toLowerCase().endsWith('.vcf')) return safeReply(ctx, '⚠️ File harus .vcf');
        const MAX_VCF_SIZE = 5 * 1024 * 1024;
        if (doc.file_size && doc.file_size > MAX_VCF_SIZE) {
            vcfPending.delete(userId);
            return safeReply(ctx, `❌ File terlalu besar. Maks 5MB.`);
        }
        await safeReply(ctx, '⏳ Membaca file VCF...');
        try {
            const fileLink = await ctx.telegram.getFileLink(doc.file_id);
            const resp     = await fetch(fileLink.href);
            const vcfText  = await resp.text();
            const contacts = parseVCF(vcfText);
            if (contacts.length === 0) {
                vcfPending.delete(userId);
                return safeReply(ctx, '❌ Tidak ada nomor valid.');
            }
            pending.contacts    = contacts;
            pending.waitingFile = false;
            vcfPending.set(userId, pending);
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback(`✅ Tambah Semua (${contacts.length})`, 'vcf_add_all')],
                [Markup.button.callback('❌ Batal', 'vcf_cancel')]
            ]);
            await safeReply(ctx, `📊 ${contacts.length} kontak ditemukan.\n🎯 Grup tujuan: ${pending.groupName}\n\nTambahkan sekarang?`, { ...keyboard });
        } catch (err) {
            vcfPending.delete(userId);
            await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
        }
        return;
    }
});

// ========== PHOTO HANDLER ==========
tgBot.on('photo', async (ctx) => {
    const userId = ctx.from.id;
    const state  = getState(userId);
    if (state && state.mode === 'rekapgroup' && state.phase === 'waiting_photo') {
        const caption      = ctx.message.caption || '';
        const captionMatch = caption.match(/^(.+?)\|(\d+)$/);
        if (captionMatch) {
            const groupName   = captionMatch[1].trim();
            const memberCount = captionMatch[2];
            clearState(userId);
            return safeReply(ctx, `📸 REKAP GRUP\n${'─'.repeat(30)}\n📋 Nama Grup: ${groupName}\n👥 Jumlah Member: ${memberCount}\n📅 Di-rekap: ${formatDate(new Date().toISOString())}`);
        }
        await safeReply(ctx, `📸 Foto diterima!\n\nBot tidak bisa membaca teks dari gambar.\nKirim ulang dengan caption format:\nNamaGrup|JumlahMember`);
    }
});

// ========== COMMANDS ==========
tgBot.command('start', async (ctx) => {
    const userId = ctx.from.id;
    const name   = ctx.from.first_name || 'User';
    const status = await getUserStatus(userId);
    const loggedIn = userSessions.get(userId)?.loggedIn;
    const kb     = await getKeyboard(userId);
    if (isAdmin(userId)) {
        return safeReply(ctx, `╔${DIVIDER}╗\n║  ${BOT_NAME}\n╚${DIVIDER}╝\n\n👑 Selamat datang, Admin ${esc(name)}!\n\n${DIVIDER_THIN}\n${loggedIn ? `✅ WA: *Terhubung*\n\n*Pilih menu di keyboard bawah:*` : `🔴 WA: *Belum login*\n\nTekan *🔑 Login WhatsApp* untuk mulai.`}`, { ...kb });
    }
    if (status === 'regular') {
        const u = db.getUser(userId);
        return safeReply(ctx, `╔${DIVIDER}╗\n║  ${BOT_NAME}\n╚${DIVIDER}╝\n\n✅ Halo ${esc(name)}!\n\n${DIVIDER_THIN}\n🏷️ Status: Premium Aktif\n📅 Hingga: ${formatDate(u.expiresAt)}\n⏳ Sisa: ${formatCountdown(u.expiresAt)}\n${DIVIDER_THIN}\n\n${loggedIn ? `📡 WA: *Terhubung* ✅` : `🔴 WA: *Belum login*`}`, { ...kb });
    }
    if (status === 'trial') {
        const u = db.getUser(userId);
        return safeReply(ctx, `╔${DIVIDER}╗\n║  ${BOT_NAME}\n╚${DIVIDER}╝\n\n🎁 Halo ${esc(name)}!\n\n${DIVIDER_THIN}\n🏷️ Status: Trial Aktif\n⏱ Habis: ${formatDate(u.trialExpiresAt)}\n⏳ Sisa: ${formatCountdown(u.trialExpiresAt)}\n${DIVIDER_THIN}\n\n${loggedIn ? `📡 WA: *Terhubung* ✅` : `🔴 WA: *Belum login*`}`, { ...kb });
    }
    if (status === 'expired' || status === 'trial_expired') {
        return safeReply(ctx, `⚠️ Akses lo sudah berakhir.\nPerpanjang untuk bisa pakai lagi!`, { ...kb });
    }
    await safeReply(ctx, `${BOT_NAME}\n\n👋 Halo ${esc(name)}!\n\nBot ini bisa:\n• Kick anggota grup WA\n• Konversi file TXT, VCF, XLSX\n• Gabung & pecah file kontak\n• Dan banyak lagi!\n\n🔧 File Tools bisa diakses semua orang.\n📱 Fitur WA butuh login & akses.\n\nPilih menu di keyboard bawah 👇`, { ...kb });
});

tgBot.command('trial', async (ctx) => {
    const user   = ctx.from;
    const status = await getUserStatus(user.id);
    if (status === 'admin') return safeReply(ctx, '👑 Lo adalah admin.', await getKeyboard(user.id));
    if (status === 'regular') return safeReply(ctx, '✅ Lo sudah punya akses reguler.', await getKeyboard(user.id));
    if (status === 'trial') {
        const u = db.getUser(user.id);
        return safeReply(ctx, `⏱ Masih trial. Sisa: ${formatCountdown(u.trialExpiresAt)}`, { ...KB_PRE_LOGIN });
    }
    // Check hadTrial
    const existing = db.getUser(user.id);
    if (existing?.hadTrial) return safeReply(ctx, `❌ Kamu sudah pernah menggunakan trial.\nKetik /beli untuk upgrade ke premium.`);
    const trialExpiresAt = new Date(Date.now() + TRIAL_DURATION_HOURS * 3600000).toISOString();
    db.saveUser({ id: user.id, role: 'trial', trialExpiresAt, hadTrial: 1, notifiedExpiry: 0 });
    await safeReply(ctx, `🎉 TRIAL AKTIF!\n\n✅ ${TRIAL_DURATION_HOURS} jam\n⏱ Berakhir: ${formatDate(trialExpiresAt)}\n\nTekan 🔑 Login WhatsApp untuk mulai!`, { ...KB_PRE_LOGIN });
});

tgBot.command('beli', async (ctx) => {
    if (isAdmin(ctx.from.id)) return safeReply(ctx, '👑 Kamu adalah admin. Tidak perlu beli paket.');
    await showPriceMenu(ctx);
});

tgBot.command('login', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (session && session.loggedIn) return safeReply(ctx, '✅ Lo udah login!');
    try { await startLogin(ctx, userId); } catch (err) {
        log('ERROR', 'Login', err.message, err);
        await safeReply(ctx, `❌ Gagal: ${esc(err.message)}`);
    }
});

tgBot.command('refreshqr', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
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
        vcfPending.delete(userId);
        await safeReply(ctx, '✅ Logout berhasil.', { ...KB_PRE_LOGIN });
    } catch (err) {
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
    }
});

tgBot.command('groups', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return safeReply(ctx, '❌ Login dulu!');
    await showGroupPicker(ctx, userId, session);
});

tgBot.command('status', requireAccess, async (ctx) => {
    const userId    = ctx.from.id;
    const session   = userSessions.get(userId);
    const accStatus = await getUserStatus(userId);
    const u         = db.getUser(userId);
    let waStatus = '🔴 Belum Login';
    if (session && !session.loggedIn) waStatus = '🟡 Menunggu QR';
    if (session && session.loggedIn)  waStatus = '🟢 Terhubung';
    let accLine = '';
    if (accStatus === 'admin')   accLine = '👑 Admin';
    else if (accStatus === 'regular') accLine = `⭐ Reguler (${formatCountdown(u?.expiresAt)})`;
    else if (accStatus === 'trial')   accLine = `🎁 Trial (${formatCountdown(u?.trialExpiresAt)})`;
    await safeReply(ctx, `📡 WA: ${waStatus}\n🏷️ Akun: ${accLine}\n🎯 Grup: ${session?.groupName || 'Belum pilih'}`);
});

tgBot.command('myaccount', async (ctx) => {
    const userId = ctx.from.id;
    const status = await getUserStatus(userId);
    if (status === 'admin') return safeReply(ctx, `👑 Admin bot.`);
    const u = db.getUser(userId);
    if (!u) return safeReply(ctx, `Belum terdaftar. Tekan 🎁 Coba Gratis`, { ...KB_LANDING });
    await safeReply(ctx, `👤 ID: ${u.id}\nStatus: ${status}\nExp: ${u.expiresAt ? formatDate(u.expiresAt) : u.trialExpiresAt ? formatDate(u.trialExpiresAt) : '-'}`);
});

tgBot.command('help', async (ctx) => {
    const helpText = `🤖 *WA KICKER BOT v7.0.0 - PANDUAN LENGKAP*\n\n${'─'.repeat(30)}\n\n🔧 *FILE TOOLS* (Bisa diakses semua)\n• 🔄 TXT → VCF - Konversi TXT ke VCF\n• 🔄 VCF → TXT - Konversi VCF ke TXT\n• 📊 XLSX → VCF - Konversi Excel ke VCF\n• 📝 TXT2VCF Auto - Auto detect format\n• 🔗 Gabung TXT - Gabung multiple TXT\n• 🔗 Gabung VCF - Gabung multiple VCF\n• ✂️ Pecah VCF - Pecah per bagian (ketik jumlah bebas)\n• ✂️ Pecah VCF (jlh) - Pecah per jumlah kontak (ketik bebas)\n• ➕ Tambah Kontak - Tambah kontak ke VCF\n• ➖ Hapus Kontak - Hapus kontak dari VCF\n• 🔢 Hitung Kontak - Hitung jumlah kontak\n• ✏️ Rename Kontak - Rename semua kontak\n• 📝 Rename File - Rename file\n• 📄 Pesan ke TXT - Simpan pesan ke TXT\n• 📸 Rekap Grup - Rekap grup dari foto\n\n💡 *Semua konversi nama file:*\n📂 Default = nama dari file asli\n✏️ Custom = kamu tentukan sendiri\n\n${'─'.repeat(30)}\n\n📱 *FITUR WA* (Perlu login)\n• 🔑 Login WhatsApp - Scan QR (anti-deteksi aktif)\n• 📋 List Grup WA - Lihat daftar grup\n• 🎯 Pilih Grup - Pilih target grup\n• ➕ Buat Grup WA - Buat grup baru\n• 📥 Import VCF - Import kontak ke grup\n• 🔴 Kick Menu - Kick anggota grup\n• 🚪 Logout WhatsApp - Keluar dari WA\n\n${'─'.repeat(30)}\n\n📋 *PERINTAH DASAR*\n• /start - Mulai bot\n• /done - Selesaikan proses\n• /batal - Batalkan proses\n• /beli - Beli premium\n• /help - Bantuan ini\n• /refreshqr - QR baru jika expired\n\n${'─'.repeat(30)}\n\n💳 *PEMBAYARAN*\n🏦 Bank: ${PAYMENT_BANK_NAME}\n📞 No Rek: ${PAYMENT_BANK_NUMBER}\n👤 A.n: ${PAYMENT_BANK_HOLDER}\n📱 Dana: ${PAYMENT_DANA}\n📩 Konfirmasi: ${PAYMENT_CONTACT}`;
    await safeReply(ctx, helpText);
});

tgBot.command(['done', 'selesai'], async (ctx) => {
    const userId = ctx.from.id;
    const state  = getState(userId);
    if (!state) return safeReply(ctx, '❌ Tidak ada proses yang berjalan.');
    switch (state.mode) {
        case 'cv_txt_to_vcf': return finalizeCvTxtToVcf(ctx, userId, state);
        case 'cv_vcf_to_txt': return finalizeCvVcfToTxt(ctx, userId, state);
        case 'gabungtxt':     return finalizeGabungTxt(ctx, userId, state);
        case 'gabungvcf':     return finalizeGabungVcf(ctx, userId, state);
        case 'totxt': {
            if (state.messages.length === 0) { clearState(userId); return safeReply(ctx, '❌ Tidak ada pesan.'); }
            await sendFile(ctx, Buffer.from(state.messages.join('\n'), 'utf-8'), `pesan_${Date.now()}.txt`, `✅ ${state.messages.length} pesan disimpan`);
            clearState(userId);
            return;
        }
        default:
            clearState(userId);
            return safeReply(ctx, '✅ Proses dihentikan.');
    }
});

tgBot.command('batal', async (ctx) => {
    clearState(ctx.from.id);
    vcfPending.delete(ctx.from.id);
    await safeReply(ctx, '✅ Proses dibatalkan.');
});

tgBot.command('buatkosongan', async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return safeReply(ctx, '❌ Login dulu!');
    const state = getState(userId);
    if (!state || state.mode !== 'buatgrup') return safeReply(ctx, '❌ Mulai dulu dengan menu ➕ Buat Grup WA.');
    try {
        const myJid    = session.sock.user?.id;
        const groupData = await session.sock.groupCreate(state.groupName, [myJid]);
        await safeReply(ctx, `✅ Grup kosong berhasil dibuat!\n\n📋 Nama: ${groupData.subject}\n🆔 ID: ${groupData.id}`);
        clearState(userId);
    } catch (err) {
        log('ERROR', 'BuatKosongan', err.message, err);
        await safeReply(ctx, `❌ Gagal buat grup: ${err.message}`);
        clearState(userId);
    }
});

tgBot.command('revoke', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return safeReply(ctx, '⛔ Hanya admin!');
    const args   = ctx.message.text.split(' ');
    if (args.length < 2) return safeReply(ctx, `Cara pakai: /revoke [user_id]\nContoh: /revoke 123456789`);
    const userId = parseInt(args[1]);
    if (isNaN(userId)) return safeReply(ctx, '❌ ID tidak valid.');
    if (!db.getUser(userId)) return safeReply(ctx, `❌ User ${userId} tidak ditemukan.`);
    db.deleteUser(userId);
    if (userSessions.has(userId)) {
        try { await destroySession(userId); } catch (_) {}
    }
    kickSelections.delete(userId);
    reconnectAttempts.delete(userId);
    conflictCooldowns.delete(userId);
    loginLocks.delete(userId);
    await safeReply(ctx, `✅ Akses user ${userId} dicabut.`);
    try { await tgBot.telegram.sendMessage(userId, `🔴 Akses Anda dicabut.\nHub. admin: ${PAYMENT_CONTACT}`); } catch (_) {}
});

tgBot.command('adduser', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return safeReply(ctx, '⛔ Akses ditolak.');
    const args     = ctx.message.text.split(' ');
    const targetId = parseInt(args[1]);
    const pkgKey   = args[2];
    if (!targetId || !pkgKey || !PACKAGES[pkgKey]) {
        return safeReply(ctx, `Format: /adduser [user_id] [paket]\n\nPaket: 1bulan / 3bulan / 6bulan / 1tahun`);
    }
    const pkg      = PACKAGES[pkgKey];
    const expiresAt = new Date(Date.now() + pkg.days * 24 * 3600000).toISOString();
    db.saveUser({ id: targetId, role: 'regular', package: pkgKey, expiresAt, hadTrial: 1, notifiedExpiry: 0 });
    await safeReply(ctx, `✅ User berhasil ditambahkan!\n\n🆔 ID: \`${targetId}\`\n📦 Paket: ${pkg.label}\n📅 Aktif hingga: ${formatDate(expiresAt)}`);
    try {
        await tgBot.telegram.sendMessage(targetId, `🎉 Akses ke ${BOT_NAME} sudah diaktifkan!\n\n📦 Paket: ${pkg.label}\n📅 Aktif hingga: ${formatDate(expiresAt)}\n\nTekan 🔑 Login WhatsApp untuk mulai.`, { parse_mode: 'Markdown', ...KB_PRE_LOGIN });
    } catch (_) {}
});

tgBot.command('pendingpayment', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const list = db.getAllPendingPayments();
    if (list.length === 0) return safeReply(ctx, `📭 Kosong.`);
    let msg = `PENDING: ${list.length}\n\n`;
    for (const p of list) {
        msg += `👤 ${p.id}\n📦 ${p.packageKey || p.package}\n📅 ${formatDate(p.requestedAt || p.date)}\n\n`;
    }
    await safeReply(ctx, msg);
});

tgBot.command('userlist', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return safeReply(ctx, '⛔ Akses ditolak.');
    const users = db.getAllUsers();
    if (users.length === 0) return safeReply(ctx, 'Belum ada user terdaftar.');
    const now     = new Date();
    const actives = users.filter(u => { const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt; return exp && new Date(exp) > now; });
    const expired = users.filter(u => { const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt; return !exp || new Date(exp) <= now; });
    let msg = `╔${DIVIDER}╗\n║  DAFTAR USER\n╚${DIVIDER}╝\n\n✅ Aktif: ${actives.length}  |  ❌ Expired: ${expired.length}\n\n`;
    actives.forEach((u, i) => {
        const exp  = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
        const role = u.role === 'trial' ? '🎁 Trial' : '⭐ Reguler';
        msg += `${i + 1}. ID: \`${u.id}\` | ${role}\n   Exp: ${formatDate(exp)} (${formatCountdown(exp)})\n\n`;
    });
    if (expired.length > 0 && expired.length <= 10) {
        expired.forEach((u, i) => {
            const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
            msg += `${i + 1}. ID: \`${u.id}\`\n   Expired: ${formatDate(exp)}\n\n`;
        });
    } else if (expired.length > 10) {
        msg += `\n_(+${expired.length} user expired tidak ditampilkan)_`;
    }
    msg += `\n\n/revoke [id] — Cabut akses`;
    await safeReply(ctx, msg);
});

// ==========================================
// ========== HEARS HANDLERS ================
// ==========================================
tgBot.hears('🔧 File Tools', async (ctx) => {
    await safeReply(ctx, `🔧 FILE TOOLS MENU\n\nPilih tool:`, { ...KB_FILE_TOOLS });
});
tgBot.hears('↩️ Kembali', async (ctx) => {
    const kb = await getKeyboard(ctx.from.id);
    await safeReply(ctx, '↩️ Kembali ke menu utama.', { ...kb });
});
tgBot.hears('🔄 TXT → VCF',     async (ctx) => handleCvTxtToVcfStart(ctx, ctx.from.id));
tgBot.hears('🔄 VCF → TXT',     async (ctx) => handleCvVcfToTxtStart(ctx, ctx.from.id));
tgBot.hears('📊 XLSX → VCF',    async (ctx) => handleCvXlsxToVcfStart(ctx, ctx.from.id));
tgBot.hears('📝 TXT2VCF Auto',  async (ctx) => handleTxt2VcfStart(ctx, ctx.from.id));
tgBot.hears('🔗 Gabung TXT',    async (ctx) => handleGabungTxtStart(ctx, ctx.from.id));
tgBot.hears('🔗 Gabung VCF',    async (ctx) => handleGabungVcfStart(ctx, ctx.from.id));
tgBot.hears('✂️ Pecah VCF',     async (ctx) => handlePecahFileStart(ctx, ctx.from.id));
tgBot.hears('✂️ Pecah VCF (jlh)', async (ctx) => handlePecahCtcStart(ctx, ctx.from.id));
tgBot.hears('➕ Tambah Kontak', async (ctx) => handleAddCtcStart(ctx, ctx.from.id));
tgBot.hears('➖ Hapus Kontak',  async (ctx) => handleDelCtcStart(ctx, ctx.from.id));
tgBot.hears('🔢 Hitung Kontak', async (ctx) => handleHitungCtcStart(ctx, ctx.from.id));
tgBot.hears('✏️ Rename Kontak', async (ctx) => handleRenamectcStart(ctx, ctx.from.id));
tgBot.hears('📸 Rekap Grup',    async (ctx) => handleRekapGroup(ctx, ctx.from.id));
tgBot.hears('📄 Pesan ke TXT',  async (ctx) => handleTotxtStart(ctx, ctx.from.id));
tgBot.hears('📁 Admin File Manager', async (ctx) => handleCvAdminFile(ctx, ctx.from.id));
tgBot.hears('📋 List Grup WA',  async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return safeReply(ctx, '❌ Login dulu!');
    await showGroupPicker(ctx, userId, session);
});
tgBot.hears('📝 Rename File', async (ctx) => {
    await safeReply(ctx, `Format: /renamefile [nama_baru]\n\nContoh: /renamefile arisan_2024`);
});

tgBot.command('renamefile', async (ctx) => {
    const args = ctx.message.text.split(' ');
    args.shift();
    await handleRenameFileStart(ctx, ctx.from.id, args.join(' ').trim());
});

// WhatsApp menu
tgBot.hears('🔑 Login WhatsApp', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (session && session.loggedIn) return safeReply(ctx, '✅ Lo udah login!');
    try { await startLogin(ctx, userId); } catch (err) {
        await safeReply(ctx, `❌ Gagal: ${esc(err.message)}`);
    }
});

tgBot.hears('📋 Daftar Grup', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return safeReply(ctx, '❌ Login dulu!');
    await showGroupPicker(ctx, userId, session);
});

tgBot.hears('🎯 Pilih Grup', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return safeReply(ctx, '❌ Login dulu!');
    await showGroupPicker(ctx, userId, session);
});

tgBot.hears('➕ Buat Grup WA', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return safeReply(ctx, '❌ Login dulu!');
    setState(userId, { mode: 'buatgrup', phase: 'waiting_name' });
    await safeReply(ctx, `➕ Buat Grup WA\n\nKirim nama grup yang ingin dibuat:\nKetik /batal untuk membatalkan.`);
});

tgBot.hears('📥 Import VCF', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return safeReply(ctx, '❌ Login dulu!');
    const fetchAnim = await spinnerMessage(ctx, 'Mengambil daftar grup...');
    try {
        const chats  = await session.sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        if (groups.length === 0) { await fetchAnim.stop(`❌ Tidak ada grup ditemukan.`); return; }
        const isTrial      = await isTrialOnly(userId);
        const displayGroups = isTrial ? groups.slice(0, 1) : groups;
        session._vcfGroupPickerList = displayGroups;
        const buttons = displayGroups.map((g, i) => {
            const memberCount = g.participants?.length || 0;
            return [Markup.button.callback(`${i + 1}. ${g.subject} (${memberCount} 👥)`.substring(0, 64), `vcfgrp_${i}`)];
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
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return safeReply(ctx, '❌ Login dulu!');
    if (!session.groupId) return safeReply(ctx, '❌ Pilih grup dulu!');
    await showKickMenu(ctx, userId, session);
});

tgBot.hears('📊 Status', requireAccess, async (ctx) => {
    const userId    = ctx.from.id;
    const session   = userSessions.get(userId);
    const accStatus = await getUserStatus(userId);
    const u         = db.getUser(userId);
    let waStatus = '🔴 Belum Login';
    if (session && !session.loggedIn) waStatus = '🟡 Menunggu QR';
    if (session && session.loggedIn)  waStatus = '🟢 Terhubung';
    let accLine = '';
    if (accStatus === 'admin')   accLine = '👑 Admin';
    else if (accStatus === 'regular') accLine = `⭐ Reguler (${formatCountdown(u?.expiresAt)})`;
    else if (accStatus === 'trial')   accLine = `🎁 Trial (${formatCountdown(u?.trialExpiresAt)})`;
    await safeReply(ctx, `📡 WA: ${waStatus}\n🏷️ Akun: ${accLine}\n🎯 Grup: ${session?.groupName || 'Belum pilih'}`);
});

tgBot.hears('👤 Akun Saya', async (ctx) => {
    const userId = ctx.from.id;
    const status = await getUserStatus(userId);
    if (status === 'admin') return safeReply(ctx, `👑 Admin bot.`);
    const u = db.getUser(userId);
    if (!u) return safeReply(ctx, `Belum terdaftar. Tekan 🎁 Coba Gratis`, { ...KB_LANDING });
    await safeReply(ctx, `👤 ID: ${u.id}\nStatus: ${status}\nExp: ${u.expiresAt ? formatDate(u.expiresAt) : u.trialExpiresAt ? formatDate(u.trialExpiresAt) : '-'}`);
});

tgBot.hears('⭐ Premium', async (ctx) => {
    if (isAdmin(ctx.from.id)) return safeReply(ctx, '👑 Kamu adalah admin. Tidak perlu beli paket.');
    await showPriceMenu(ctx);
});

tgBot.hears('🎁 Coba Gratis (Trial)', async (ctx) => {
    const userId = ctx.from.id;
    if (isAdmin(userId)) return safeReply(ctx, '👑 Kamu adalah admin, tidak perlu trial.');
    const existing = db.getUser(userId);
    if (existing?.hadTrial) return safeReply(ctx, '❌ Kamu sudah pernah menggunakan trial.\nKetik /beli untuk upgrade ke premium.');
    if (existing?.role === 'regular') return safeReply(ctx, '✅ Kamu sudah punya paket premium aktif!');
    const trialExpiresAt = new Date(Date.now() + TRIAL_DURATION_HOURS * 3600000).toISOString();
    db.saveUser({ id: userId, role: 'trial', trialExpiresAt, hadTrial: 1, notifiedExpiry: 0 });
    const kb = await getKeyboard(userId);
    await safeReply(ctx, `🎁 TRIAL AKTIF!\n\n⏳ Masa trial: ${TRIAL_DURATION_HOURS} jam\n📅 Berakhir: ${formatDate(trialExpiresAt)}\n\nSelamat mencoba! Gunakan menu di bawah.`, { ...kb });
});

tgBot.hears('❓ Bantuan', async (ctx) => {
    tgBot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/help' } });
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
        vcfPending.delete(userId);
        const kb = await getKeyboard(userId);
        await safeReply(ctx, '✅ Logout berhasil.', { ...kb });
    } catch (err) {
        await safeReply(ctx, `❌ Error: ${esc(err.message)}`);
    }
});

tgBot.hears('📋 Pending Payment', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const list = db.getAllPendingPayments();
    if (list.length === 0) return safeReply(ctx, `📭 Kosong.`);
    let msg = `PENDING: ${list.length}\n\n`;
    for (const p of list) {
        msg += `👤 ${p.id}\n📦 ${p.packageKey || p.package}\n📅 ${formatDate(p.requestedAt || p.date)}\n\n`;
    }
    await safeReply(ctx, msg);
});

tgBot.hears('👥 User List', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return safeReply(ctx, '⛔ Hanya admin.');
    const users = db.getAllUsers();
    if (users.length === 0) return safeReply(ctx, '👥 Belum ada user terdaftar.');
    const buttons = users.slice(0, 30).map(u => {
        const label = `${u.role === 'regular' ? '⭐' : u.role === 'trial' ? '🎁' : '❓'} ${u.id} (${u.role})`;
        return [Markup.button.callback(label, `userinfo_${u.id}`)];
    });
    buttons.push([Markup.button.callback('❌ Tutup', 'close_userlist')]);
    await safeReply(ctx, `👥 DAFTAR USER (${users.length})\n\nKlik untuk detail & revoke:`, {
        reply_markup: { inline_keyboard: buttons }
    });
});

// =============================================
// ========== INLINE BUTTON HANDLERS ===========
// =============================================

// Select Group
tgBot.action(/^selectgrp_(\d+|cancel)$/, requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    await ctx.answerCbQuery();
    const param   = ctx.match[1];
    const session = userSessions.get(userId);
    if (param === 'cancel') {
        if (session) session._groupPickerList = null;
        return ctx.editMessageText('✖ Pemilihan grup dibatalkan.');
    }
    if (!session || !session.loggedIn) return ctx.editMessageText('❌ Session habis. Login ulang.');
    const idx       = parseInt(param);
    const groupList = session._groupPickerList;
    if (!groupList || isNaN(idx) || idx < 0 || idx >= groupList.length) return ctx.editMessageText('❌ Data grup tidak ditemukan. Coba lagi.');
    const target = groupList[idx];
    session.groupId   = target.id;
    session.groupName = target.subject;
    session._groupPickerList = null;
    const memberCount = target.participants?.length || 0;
    await ctx.editMessageText(`✅ Grup terpilih!\n\n🎯 ${esc(target.subject)}\n👥 ${memberCount} anggota\n\nTekan 🔴 Kick Menu untuk mulai.`);
});

// VCF group picker
tgBot.action(/^vcfgrp_(\d+|cancel)$/, requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    await ctx.answerCbQuery();
    const param   = ctx.match[1];
    const session = userSessions.get(userId);
    if (param === 'cancel') {
        if (session) session._vcfGroupPickerList = null;
        return ctx.editMessageText('✖ Import VCF dibatalkan.');
    }
    if (!session || !session.loggedIn) return ctx.editMessageText('❌ Session habis. Login ulang.');
    const idx       = parseInt(param);
    const groupList = session._vcfGroupPickerList;
    if (!groupList || isNaN(idx) || idx < 0 || idx >= groupList.length) return ctx.editMessageText('❌ Data grup tidak ditemukan. Coba lagi.');
    const target = groupList[idx];
    session._vcfGroupPickerList = null;
    vcfPending.set(userId, { waitingFile: true, groupId: target.id, groupName: target.subject, createdAt: Date.now() });
    await ctx.editMessageText(`✅ Grup tujuan VCF dipilih!\n\n🎯 ${esc(target.subject)}\n👥 ${target.participants?.length || 0} anggota\n\n📎 Sekarang kirim file .vcf ke chat ini.`);
});

// VCF Add All
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

// Kick toggle & actions
tgBot.action(/^toggle_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    if (!await canUseBot(userId)) return ctx.answerCbQuery('⛔ Ditolak.');
    touchSession(userId);
    const jid      = ctx.match[1];
    const session  = userSessions.get(userId);
    if (!session || !kickSelections.has(userId)) return ctx.answerCbQuery('Session expired.');
    const selected = kickSelections.get(userId);
    if (selected.has(jid)) {
        selected.delete(jid);
        await ctx.answerCbQuery('❌ Dihapus');
    } else {
        selected.add(jid);
        await ctx.answerCbQuery('✅ Ditambahkan');
    }
    try { await ctx.editMessageReplyMarkup(buildMemberKeyboard(session.members, selected).reply_markup); } catch (_) {}
});

tgBot.action('do_kick', async (ctx) => {
    const userId = ctx.from.id;
    if (!await canUseBot(userId)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();
    touchSession(userId);
    if (!isAdmin(userId) && !isActiveHours()) {
        return safeReply(ctx, `⚠️ Untuk keamanan akun WA, kick hanya bisa dilakukan jam 08.00 - 22.00 WIB.\n\n_Ini untuk menghindari deteksi otomatis dari WhatsApp._`);
    }
    const session  = userSessions.get(userId);
    const selected = kickSelections.get(userId);
    if (!session || !session.loggedIn) return safeReply(ctx, '❌ Session expired.');
    if (!selected || selected.size === 0) return safeReply(ctx, '⚠️ Belum ada yang dipilih!');
    const jidList  = Array.from(selected);
    const kickAnim = await liveKickProgress(ctx, jidList.length);
    const kickResult = await naturalKickOneByOne(session.sock, session.groupId, jidList, (progress) => { kickAnim.update(progress); });
    kickSelections.set(userId, new Set());
    const totalKicked = kickResult.kicked;
    if (kickResult.stopped && kickResult.reason === 'connection') {
        await kickAnim.stop(`🔴 Koneksi WA terputus!\n\n🦵 ${totalKicked} dari ${jidList.length} berhasil dikick.\nTekan 🔑 Login untuk reconnect.`);
    } else {
        await kickAnim.stop(`✅ Kick Selesai!\n\n🦵 ${totalKicked} dari ${jidList.length} anggota berhasil dikick.\n🎯 Grup: ${esc(session.groupName || 'N/A')}`);
    }
});

tgBot.action('cancel_kick', async (ctx) => {
    kickSelections.set(ctx.from.id, new Set());
    await ctx.answerCbQuery('Dibatalkan');
    await safeReply(ctx, '✖ Kick dibatalkan.');
});

// Rename actions
tgBot.action('rename_prefix', async (ctx) => {
    await ctx.answerCbQuery();
    const state = getState(ctx.from.id);
    if (!state || state.mode !== 'renamectc') return;
    setState(ctx.from.id, { ...state, phase: 'input_prefix' });
    await safeReply(ctx, '✏️ Masukkan prefix:\n\nContoh: Tim A\nHasil: "Tim A Budi"');
});
tgBot.action('rename_suffix', async (ctx) => {
    await ctx.answerCbQuery();
    const state = getState(ctx.from.id);
    if (!state || state.mode !== 'renamectc') return;
    setState(ctx.from.id, { ...state, phase: 'input_suffix' });
    await safeReply(ctx, '✏️ Masukkan suffix:\n\nContoh: (2025)\nHasil: "Budi (2025)"');
});
tgBot.action('rename_numbered', async (ctx) => {
    await ctx.answerCbQuery();
    const state = getState(ctx.from.id);
    if (!state || state.mode !== 'renamectc') return;
    setState(ctx.from.id, { ...state, phase: 'input_numbered' });
    await safeReply(ctx, '✏️ Masukkan nama template:\n\nContoh: Member\nHasil: "Member 1", "Member 2"...');
});
tgBot.action('rename_cancel', async (ctx) => {
    clearState(ctx.from.id);
    await ctx.editMessageText('✖ Dibatalkan.');
});

// Pecah VCF bagian — handler setelah naming (untuk pecahfile_parts)
tgBot.action(/^naming_default_(\d+)$/, async (ctx) => {}); // already handled above
// Note: naming_default / naming_custom already registered above, the handler checks pendingFinalize

// Admin File Manager
tgBot.action('adminfile_upload', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();
    await handleAdminFileUpload(ctx, ctx.from.id);
});
tgBot.action('adminfile_list', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();
    try {
        const files = fs.readdirSync(ADMIN_FILES_DIR);
        if (files.length === 0) return safeReply(ctx, '📂 Direktori kosong.');
        let text = `📂 DAFTAR FILE ADMIN\n${'─'.repeat(30)}\n`;
        files.forEach((f, i) => {
            const stats = fs.statSync(path.join(ADMIN_FILES_DIR, f));
            text += `${i + 1}. ${f} (${(stats.size / 1024).toFixed(1)}KB)\n`;
        });
        text += `${'─'.repeat(30)}\nTotal: ${files.length} file`;
        await safeReply(ctx, text);
    } catch (err) { await safeReply(ctx, `❌ Error: ${err.message}`); }
});
tgBot.action('adminfile_delete', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();
    try {
        const files = fs.readdirSync(ADMIN_FILES_DIR);
        if (files.length === 0) return safeReply(ctx, '📂 Tidak ada file.');
        const buttons = files.map((f, i) => [Markup.button.callback(`🗑️ ${f.substring(0, 30)}`, `adminfiledel_${i}`)]);
        buttons.push([Markup.button.callback('❌ Batal', 'adminfiledel_cancel')]);
        setState(ctx.from.id, { mode: 'cvadminfile_delete', fileList: files });
        await safeReply(ctx, `🗑️ HAPUS FILE ADMIN\n\nPilih file:`, { reply_markup: { inline_keyboard: buttons } });
    } catch (err) { await safeReply(ctx, `❌ Error: ${err.message}`); }
});
tgBot.action(/^adminfiledel_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
    const idx   = parseInt(ctx.match[1]);
    const state = getState(ctx.from.id);
    if (!state?.fileList) return ctx.editMessageText('❌ Session expired.');
    const fileName = state.fileList[idx];
    if (!fileName) return ctx.editMessageText('❌ File tidak ditemukan.');
    try {
        fs.unlinkSync(path.join(ADMIN_FILES_DIR, safeFilename(fileName)));
        clearState(ctx.from.id);
        await ctx.editMessageText(`✅ Dihapus: ${fileName}`);
    } catch (err) { await ctx.editMessageText(`❌ Error: ${err.message}`); }
});
tgBot.action('adminfiledel_cancel', async (ctx) => {
    clearState(ctx.from.id);
    await ctx.editMessageText('✖ Dibatalkan.');
});
tgBot.action('adminfile_download', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();
    try {
        const files = fs.readdirSync(ADMIN_FILES_DIR);
        if (files.length === 0) return safeReply(ctx, '📂 Tidak ada file.');
        const buttons = files.map((f, i) => [Markup.button.callback(`📥 ${f.substring(0, 30)}`, `adminfiledl_${i}`)]);
        buttons.push([Markup.button.callback('❌ Batal', 'adminfiledl_cancel')]);
        setState(ctx.from.id, { mode: 'cvadminfile_download', fileList: files });
        await safeReply(ctx, `📥 DOWNLOAD FILE ADMIN\n\nPilih file:`, { reply_markup: { inline_keyboard: buttons } });
    } catch (err) { await safeReply(ctx, `❌ Error: ${err.message}`); }
});
tgBot.action(/^adminfiledl_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();
    const idx   = parseInt(ctx.match[1]);
    const state = getState(ctx.from.id);
    if (!state?.fileList) return ctx.editMessageText('❌ Session expired.');
    const fileName = state.fileList[idx];
    if (!fileName) return ctx.editMessageText('❌ File tidak ditemukan.');
    try {
        const safeName = safeFilename(fileName);
        const buffer   = fs.readFileSync(path.join(ADMIN_FILES_DIR, safeName));
        await sendFile(ctx, buffer, safeName, `📥 File: ${safeName}`);
        clearState(ctx.from.id);
    } catch (err) { await ctx.editMessageText(`❌ Error: ${err.message}`); }
});
tgBot.action('adminfiledl_cancel', async (ctx) => {
    clearState(ctx.from.id);
    await ctx.editMessageText('✖ Dibatalkan.');
});

// User info & revoke
tgBot.action(/^userinfo_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Hanya admin!');
    await ctx.answerCbQuery();
    const userId = parseInt(ctx.match[1]);
    const user   = db.getUser(userId);
    if (!user) return ctx.editMessageText('❌ User tidak ditemukan.');
    const expiry   = user.role === 'regular' ? formatDate(user.expiresAt) : user.role === 'trial' ? formatDate(user.trialExpiresAt) : '-';
    const roleIcon = user.role === 'regular' ? '⭐' : user.role === 'trial' ? '🎁' : '❓';
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🔴 Revoke Akses', `revoke_${userId}`)],
        [Markup.button.callback('↩️ Kembali', 'back_userlist')]
    ]);
    await ctx.editMessageText(`👤 DETAIL USER\n${'─'.repeat(30)}\n🆔 ID: ${userId}\n📋 Role: ${roleIcon} ${user.role}\n📅 Expires: ${expiry}`, { ...keyboard });
});
tgBot.action(/^revoke_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Hanya admin!');
    await ctx.answerCbQuery('🔴 Revoking...');
    const userId = parseInt(ctx.match[1]);
    const user   = db.getUser(userId);
    if (!user) return ctx.editMessageText('❌ User tidak ditemukan.');
    db.deleteUser(userId);
    if (userSessions.has(userId)) {
        try { await destroySession(userId); } catch (_) {}
    }
    kickSelections.delete(userId);
    reconnectAttempts.delete(userId);
    conflictCooldowns.delete(userId);
    loginLocks.delete(userId);
    await ctx.editMessageText(`✅ Akses user ${userId} dicabut.`);
    try { await tgBot.telegram.sendMessage(userId, `🔴 Akses Anda dicabut.\nHub. admin: ${PAYMENT_CONTACT}`); } catch (_) {}
});
tgBot.action('back_userlist', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const users = db.getAllUsers();
    if (users.length === 0) return ctx.editMessageText('👥 Belum ada user.');
    const buttons = users.slice(0, 30).map(u => {
        const label = `${u.role === 'regular' ? '⭐' : u.role === 'trial' ? '🎁' : '❓'} ${u.id} (${u.role})`;
        return [Markup.button.callback(label, `userinfo_${u.id}`)];
    });
    buttons.push([Markup.button.callback('❌ Tutup', 'close_userlist')]);
    await ctx.editMessageText(`👥 DAFTAR USER (${users.length})`, { reply_markup: { inline_keyboard: buttons } });
});
tgBot.action('close_userlist', async (ctx) => { try { await ctx.deleteMessage(); } catch (_) {} });

// =============================================
// ========== PREMIUM / ORDER HANDLERS =========
// =============================================
async function showPriceMenu(ctx) {
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(`📦 1 Bulan — ${formatRupiah(PACKAGES['1bulan'].price)}`, 'buy_1bulan')],
        [Markup.button.callback(`📦 3 Bulan — ${formatRupiah(PACKAGES['3bulan'].price)}`, 'buy_3bulan')],
        [Markup.button.callback(`📦 6 Bulan — ${formatRupiah(PACKAGES['6bulan'].price)}`, 'buy_6bulan')],
        [Markup.button.callback(`🏆 1 Tahun — ${formatRupiah(PACKAGES['1tahun'].price)}`, 'buy_1tahun')],
    ]);
    await safeReply(ctx, `╔${DIVIDER}╗\n║  PAKET HARGA\n╚${DIVIDER}╝\n\n📦 1 Bulan → ${formatRupiah(PACKAGES['1bulan'].price)}\n📦 3 Bulan → ${formatRupiah(PACKAGES['3bulan'].price)}\n📦 6 Bulan → ${formatRupiah(PACKAGES['6bulan'].price)}\n🏆 1 Tahun → ${formatRupiah(PACKAGES['1tahun'].price)}\n\nPilih paket di bawah:`, { ...keyboard });
}

Object.keys(PACKAGES).forEach(pkgKey => {
    tgBot.action(`buy_${pkgKey}`, async (ctx) => {
        await ctx.answerCbQuery();
        if (isAdmin(ctx.from.id)) return safeReply(ctx, '👑 Kamu adalah admin. Tidak perlu beli paket.');
        const pkg  = PACKAGES[pkgKey];
        const user = ctx.from;
        db.addPendingPayment({ id: user.id, username: user.username || null, firstName: user.first_name || '', lastName: user.last_name || '', packageKey: pkgKey, requestedAt: new Date().toISOString() });
        for (const adminId of ADMIN_IDS) {
            try {
                const approveKeyboard = Markup.inlineKeyboard([[
                    Markup.button.callback(`✅ Approve`, `admin_approve_${user.id}_${pkgKey}`),
                    Markup.button.callback(`❌ Reject`, `admin_reject_${user.id}`)
                ]]);
                await tgBot.telegram.sendMessage(adminId, `🔔 Permintaan Beli\n👤 ${user.id} (@${user.username || '-'})\n📦 ${pkg.label} (${formatRupiah(pkg.price)})`, { ...approveKeyboard });
            } catch (_) {}
        }
        await safeReply(ctx, `✅ Permintaan diterima!\n\n💰 ${formatRupiah(pkg.price)}\n${PAYMENT_INFO}\n\nKonfirmasi ke ${PAYMENT_CONTACT} dengan format: KICKER-${user.id}-${pkgKey}`);
    });
});

tgBot.action(/^admin_approve_(\d+)_(\w+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();
    const targetId = parseInt(ctx.match[1]);
    const pkgKey   = ctx.match[2];
    if (!PACKAGES[pkgKey]) return ctx.editMessageText(`❌ Paket tidak valid: ${pkgKey}`);
    const pkg      = PACKAGES[pkgKey];
    const expiresAt = new Date(Date.now() + pkg.days * 24 * 3600000).toISOString();
    db.saveUser({ id: targetId, role: 'regular', package: pkgKey, expiresAt, hadTrial: 1, notifiedExpiry: 0 });
    db.removePendingPayment(targetId);
    await ctx.editMessageText(`✅ APPROVED!\nID: ${targetId}\nPaket: ${pkg.label}\nAktif hingga: ${formatDate(expiresAt)}`);
    try { await tgBot.telegram.sendMessage(targetId, `🎉 PEMBAYARAN DIKONFIRMASI!\n\n📦 ${pkg.label}\n📅 Aktif hingga: ${formatDate(expiresAt)}\n\nTekan 🔑 Login WhatsApp untuk mulai.`, { parse_mode: 'Markdown', ...KB_PRE_LOGIN }); } catch (_) {}
});

tgBot.action(/^admin_reject_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();
    const targetId = parseInt(ctx.match[1]);
    db.removePendingPayment(targetId);
    await ctx.editMessageText(`❌ REJECTED\nID: ${targetId}`);
    try { await tgBot.telegram.sendMessage(targetId, `❌ Pembayaran ditolak.\nHubungi ${PAYMENT_CONTACT}`, { parse_mode: 'Markdown', ...KB_LANDING }); } catch (_) {}
});

// ========== EXPIRY CHECKER ==========
setInterval(async () => {
    const users = db.getAllUsers();
    const now   = new Date();
    for (const u of users) {
        if (u.notifiedExpiry) continue;
        const expiry = u.role === 'regular' ? u.expiresAt : u.role === 'trial' ? u.trialExpiresAt : null;
        if (!expiry) continue;
        const msLeft = new Date(expiry) - now;
        if (msLeft > 0 && msLeft < 24 * 3600000) {
            try {
                await tgBot.telegram.sendMessage(u.id, `⚠️ Akses ${u.role} kamu akan berakhir dalam ${formatCountdown(expiry)}!\n\nKetik /beli untuk perpanjang.`);
                db.updateNotifiedFlag(u.id);
            } catch (_) {}
        }
    }
}, 60 * 60 * 1000);

// ========== HEALTH CHECK ==========
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
    }

    const apiKey = url.searchParams.get('key') || req.headers['x-api-key'];
    if (apiKey !== HEALTH_API_KEY) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status:     'ok',
        bot:        'WA Kicker Bot v7.0.0',
        uptime:     Math.floor(process.uptime()) + 's',
        timestamp:  new Date().toISOString(),
        sessions:   userSessions.size,
        states:     userStates.size,
        xlsxReady:  XLSX !== null
    }));
}).listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Health check aktif di port ${PORT}`);
});

// ========== GRACEFUL SHUTDOWN ==========
async function gracefulShutdown(signal) {
    console.log(`\n🛑 Menerima ${signal}, shutdown graceful...`);
    tgBot.stop(signal);
    const closePromises = [];
    for (const [userId, session] of userSessions.entries()) {
        if (session?.sock) {
            closePromises.push(
                Promise.race([
                    session.sock.logout().catch(() => session.sock.end(new Error('shutdown'))),
                    new Promise(r => setTimeout(r, 3000))
                ])
            );
        }
    }
    await Promise.allSettled(closePromises);
    console.log('👋 Bot berhenti dengan bersih.');
    process.exit(0);
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => log('ERROR', 'UnhandledRejection', `${reason}`));
process.on('uncaughtException',  (err)    => log('ERROR', 'UncaughtException', err.message, err));

// ========== LAUNCH ==========
tgBot.launch().then(() => {
    console.log('\n╔══════════════════════════════════════════════════════════════════╗');
    console.log('║       W A - K I C K E R   B O T   v 7 . 0 . 0                  ║');
    console.log('║  MERGED: BADAK WA ENGINE + UPGRADED FILE TOOLS                  ║');
    console.log('╠══════════════════════════════════════════════════════════════════╣');
    console.log(`║  Admin IDs      : ${ADMIN_IDS.join(', ')}`);
    console.log(`║  Trial          : ${TRIAL_DURATION_HOURS} jam`);
    console.log(`║  Max File       : ${MAX_FILE_SIZE_MB}MB`);
    console.log(`║  Max Kontak     : ${MAX_CONTACTS_PER_FILE.toLocaleString()}/file`);
    console.log(`║  XLSX Support   : ${XLSX ? '✅ AKTIF' : '❌ npm install xlsx'}`);
    console.log(`║  WA Engine      : BADAK (human delay + fingerprint + reconnect)  ║`);
    console.log('╚══════════════════════════════════════════════════════════════════╝\n');
    console.log('✅ CHANGELOG v7.0.0:');
    console.log('   [WA] Ganti full WA engine dari badak (human delay, fingerprint dinamis)');
    console.log('   [WA] Reconnect otomatis 3x, Stream Conflict cooldown, background spoofer');
    console.log('   [WA] Animasi live progress (kick/add), QR variatif (gambar/teks)');
    console.log('   [FILE] Semua konversi tanya dulu: Default atau Custom nama (kb inline)');
    console.log('   [FILE] Pecah VCF: user ketik jumlah bebas, tidak ada batasan tombol');
    console.log('   [FILE] Pecah VCF (jlh): user ketik jumlah kontak/file bebas');
    console.log('\n🚀 Bot siap digunakan!\n');
}).catch(err => {
    console.error('❌ Gagal launch bot:', err.message);
    process.exit(1);
});
