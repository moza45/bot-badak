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
// ║         W A - K I C K E R   B O T   v 6 . 3 . 0            ║
// ║           NO-SPAM + ALL FIXED                               ║
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
const HEALTH_API_KEY       = process.env.HEALTH_API_KEY || (() => {
    console.warn('⚠️  HEALTH_API_KEY tidak diset di .env — monitoring eksternal akan terputus setiap restart!');
    return crypto.randomBytes(16).toString('hex');
})();
const MAX_FILE_SIZE_MB     = parseInt(process.env.MAX_FILE_SIZE_MB || '10');
const MAX_FILES_PER_BATCH  = parseInt(process.env.MAX_FILES_PER_BATCH || '20');
const MAX_CONTACTS_PER_FILE = parseInt(process.env.MAX_CONTACTS_PER_FILE || '50000');
const MAX_ADMIN_FILES      = parseInt(process.env.MAX_ADMIN_FILES || '100');
const DOWNLOAD_TIMEOUT_MS  = parseInt(process.env.DOWNLOAD_TIMEOUT_MS || '30000');

// ========== PERSISTENT STORAGE ==========
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const AUTH_BASE_FOLDER = path.join(DATA_DIR, 'auth_states');
if (!fs.existsSync(AUTH_BASE_FOLDER)) fs.mkdirSync(AUTH_BASE_FOLDER, { recursive: true });

const ADMIN_FILES_DIR = process.env.ADMIN_FILES_DIR || path.join(DATA_DIR, 'admin_files');
if (!fs.existsSync(ADMIN_FILES_DIR)) fs.mkdirSync(ADMIN_FILES_DIR, { recursive: true });

const TEMP_DIR = path.join(DATA_DIR, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

let XLSX = null;
try {
    XLSX = require('xlsx');
    console.log('✅ xlsx package loaded successfully');
} catch (e) {
    console.log('⚠️  xlsx package tidak terinstall. Fitur /cv_xlsx_to_vcf tidak akan berfungsi.');
}

// ========== DATABASE JSON ==========
const USERS_FILE    = path.join(DATA_DIR, 'users.json');
const PAYMENTS_FILE = path.join(DATA_DIR, 'payments.json');

function readJSON(filePath, defaultVal = null) {
    try {
        if (!fs.existsSync(filePath)) return defaultVal;
        const data = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(data);
    } catch (e) {
        return defaultVal;
    }
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
    constructor() {
        this.users    = readJSON(USERS_FILE, {});
        this.payments = readJSON(PAYMENTS_FILE, {});
    }

    getUser(userId) {
        return this.users[String(userId)] || null;
    }

    saveUser(user) {
        this.users[String(user.id)] = {
            ...user,
            hadTrial:       user.hadTrial       ? 1 : 0,
            notifiedExpiry: user.notifiedExpiry ? 1 : 0,
            updatedAt:      new Date().toISOString()
        };
        try {
            writeJSON(USERS_FILE, this.users);
        } catch (err) {
            log('ERROR', 'DB', `Gagal simpan user ${user.id}: ${err.message}`, err);
        }
    }

    getAllUsers() {
        return Object.values(this.users);
    }

    deleteUser(userId) {
        delete this.users[String(userId)];
        try {
            writeJSON(USERS_FILE, this.users);
        } catch (err) {
            log('ERROR', 'DB', `Gagal hapus user ${userId}: ${err.message}`, err);
        }
    }

    getAllPendingPayments() {
        return Object.values(this.payments);
    }

    addPendingPayment(payment) {
        this.payments[String(payment.id)] = payment;
        try {
            writeJSON(PAYMENTS_FILE, this.payments);
        } catch (err) {
            log('ERROR', 'DB', `Gagal simpan payment: ${err.message}`, err);
        }
    }

    removePendingPayment(userId) {
        delete this.payments[String(userId)];
        try {
            writeJSON(PAYMENTS_FILE, this.payments);
        } catch (err) {
            log('ERROR', 'DB', `Gagal hapus payment: ${err.message}`, err);
        }
    }

    updateNotifiedFlag(userId) {
        if (this.users[String(userId)]) {
            this.users[String(userId)].notifiedExpiry = 1;
            try {
                writeJSON(USERS_FILE, this.users);
            } catch (err) {
                log('ERROR', 'DB', `Gagal update flag notif: ${err.message}`, err);
            }
        }
    }
}
const db = new UserDatabase();

function log(level, module, message, error = null) {
    const timestamp = new Date().toISOString();
    const prefix = level === 'ERROR' ? '❌' : level === 'WARN' ? '⚠️' : '📘';
    console.log(`${timestamp} ${prefix} [${module}] ${message}`);
    if (error) console.error(error);
}

// ========== GLOBAL STATE ==========
const tgBot = new Telegraf(TELEGRAM_BOT_TOKEN);
const userStates    = new Map();
const userSessions  = new Map();
const kickSelections = new Map();
const loginLocks    = new Map();
const vcfPending    = new Map();

// ========== RATE LIMITER ==========
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX       = 10;

function isRateLimited(userId) {
    const now   = Date.now();
    const entry = rateLimitMap.get(userId) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    if (now > entry.resetAt) {
        entry.count  = 1;
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
        try { await ctx.reply('⏳ Terlalu cepat! Tunggu beberapa detik.'); } catch (_) {}
        return;
    }
    return next();
});

// ========== FUNGSI HELPERS ==========
function isAdmin(userId) {
    return ADMIN_IDS.includes(userId);
}

async function getUserStatus(userId) {
    if (isAdmin(userId)) return 'admin';
    const u = db.getUser(userId);
    if (!u) return 'none';
    if (u.role === 'regular') {
        return new Date(u.expiresAt) > new Date() ? 'regular' : 'expired';
    }
    if (u.role === 'trial') {
        return new Date(u.trialExpiresAt) > new Date() ? 'trial' : 'trial_expired';
    }
    return 'none';
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

function formatRupiah(num) {
    return 'Rp ' + num.toLocaleString('id-ID');
}

function esc(text) {
    if (!text) return '';
    return String(text).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}

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
    try {
        return await ctx.reply(text, opts);
    } catch (err) {
        log('WARN', 'SafeReply', `Gagal kirim pesan (attempt 1): ${err.message}`);
        try {
            return await ctx.reply(text.replace(/[*_`[\]()~>#+=|{}.!\\-]/g, ''), opts);
        } catch (err2) {
            log('WARN', 'SafeReply', `Gagal kirim pesan (attempt 2): ${err2.message}`);
        }
    }
}

async function downloadTelegramFile(ctx, fileId, fileSizeMB = null) {
    if (fileSizeMB !== null && fileSizeMB > MAX_FILE_SIZE_MB) {
        throw new Error(`File terlalu besar. Maks ${MAX_FILE_SIZE_MB}MB.`);
    }

    const fileLink = await ctx.telegram.getFileLink(fileId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    try {
        const resp = await fetch(fileLink.href, { signal: controller.signal });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} saat download file`);
        const buffer = Buffer.from(await resp.arrayBuffer());
        if (buffer.length > MAX_FILE_SIZE_MB * 1024 * 1024) {
            throw new Error(`File terlalu besar. Maks ${MAX_FILE_SIZE_MB}MB.`);
        }
        return buffer;
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`Download timeout setelah ${DOWNLOAD_TIMEOUT_MS / 1000}s.`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

function bytesToMB(bytes) {
    return bytes ? bytes / (1024 * 1024) : null;
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
    const seen     = new Set();
    const blocks   = vcfText.split(/END:VCARD/i).map(b => b.trim()).filter(Boolean);

    for (const block of blocks) {
        if (contacts.length >= MAX_CONTACTS_PER_FILE) {
            log('WARN', 'parseVCF', `Batas ${MAX_CONTACTS_PER_FILE} kontak tercapai, sisanya dilewati.`);
            break;
        }
        let name     = 'Tanpa Nama';
        const fnMatch = block.match(/^FN[;:][^\r\n]*/mi);
        if (fnMatch) name = fnMatch[0].replace(/^FN.*?:/i, '').trim();
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
        if (/^\+?[0-9]{10,15}$/.test(a.replace(/[\s\-().]/g, ''))) {
            return { phone: a, name: b };
        }
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
const STATE_TTL_MS = 30 * 60 * 1000;

function setState(userId, data) {
    userStates.set(userId, { ...data, expiresAt: Date.now() + STATE_TTL_MS });
}

function getState(userId) {
    const state = userStates.get(userId);
    if (!state) return null;
    if (Date.now() > state.expiresAt) {
        userStates.delete(userId);
        return null;
    }
    return state;
}

function clearState(userId) {
    userStates.delete(userId);
}

setInterval(() => {
    const now = Date.now();

    for (const [uid, state] of userStates.entries()) {
        if (state.expiresAt && now > state.expiresAt) {
            userStates.delete(uid);
        }
    }

    for (const [uid, pending] of vcfPending.entries()) {
        if (pending.createdAt && now - pending.createdAt > 15 * 60 * 1000) {
            vcfPending.delete(uid);
        }
    }

    for (const [uid, sel] of kickSelections.entries()) {
        if (sel.createdAt && now - sel.createdAt > 30 * 60 * 1000) {
            kickSelections.delete(uid);
        }
    }

    for (const [uid, lockTime] of loginLocks.entries()) {
        if (now - lockTime > 5 * 60 * 1000) {
            loginLocks.delete(uid);
        }
    }

    for (const [uid, entry] of rateLimitMap.entries()) {
        if (now > entry.resetAt + 60000) rateLimitMap.delete(uid);
    }
}, 10 * 60 * 1000);

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
            [{ text: '🔴 Kick Menu' }, { text: '📡 Status' }],
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
            [{ text: '🔴 Kick Menu' }, { text: '📡 Status' }],
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
    if (status === 'expired') {
        return safeReply(ctx, `╔══════════════════════╗\n║  AKSES BERAKHIR\n╚══════════════════════╝\n\nPaket kamu sudah expired.\nPerpanjang sekarang!\n\nKetik /beli untuk lihat paket.`, { ...KB_LANDING });
    }
    if (status === 'trial_expired') {
        return safeReply(ctx, `╔══════════════════════╗\n║  TRIAL BERAKHIR\n╚══════════════════════╝\n\nMasa trial kamu sudah habis.\nUpgrade ke paket reguler!\n\nKetik /beli untuk lihat paket.`, { ...KB_LANDING });
    }
    await safeReply(ctx, `╔══════════════════════╗\n║  AKSES DITOLAK\n╚══════════════════════╝\n\nBot ini berbayar.\n\n🎁 Coba gratis ${TRIAL_DURATION_HOURS} jam\n💳 Atau langsung beli paket`, { ...KB_LANDING });
}

// ========== FILE HANDLERS (NO-SPAM VERSION) ==========

// --- 1. TXT to VCF (Multiple) ---
async function handleCvTxtToVcfStart(ctx, userId) {
    setState(userId, { mode: 'cv_txt_to_vcf', files: [], fileNames: [], collecting: true });
    await safeReply(ctx, `📥 *Mengumpulkan file TXT...*\n\nKirim file lain atau ketik /done`);
}

async function handleCvTxtToVcfFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.txt';
    if (!fname.toLowerCase().endsWith('.txt')) {
        return safeReply(ctx, '⚠️ Hanya file .txt yang diterima.');
    }
    if (state.files.length >= MAX_FILES_PER_BATCH) {
        return safeReply(ctx, `❌ Maksimal ${MAX_FILES_PER_BATCH} file per batch.`);
    }
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
    try {
        const fileList = state.fileNames.map((f, i) => `${i+1}. ${f}`).join('\n');
        await safeReply(ctx, `📥 *${state.files.length} file diterima:*\n\n${fileList}\n\n${'─'.repeat(30)}\n⏳ Memproses konversi...`);
        
        const results = [];
        for (const file of state.files) {
            const contacts    = parseTxtLines(file.content);
            const baseName    = file.name.replace(/\.txt$/i, '');
            const vcfContent  = generateVCF(contacts);
            const vcfBuffer   = Buffer.from(vcfContent, 'utf-8');
            await sendFile(ctx, vcfBuffer, `${baseName}.vcf`, `✅ ${file.name} → ${baseName}.vcf (${contacts.length} kontak)`);
            results.push(`✅ ${file.name} → ${baseName}.vcf (${contacts.length} kontak)`);
        }
        await safeReply(ctx, `📦 *HASIL KONVERSI*\n\n${results.join('\n')}\n\n📊 Total: ${state.files.length} file diproses`);
    } catch (err) {
        log('ERROR', 'CvTxtToVcf', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
    } finally {
        clearState(userId);
    }
}

// --- 2. VCF to TXT (Multiple) ---
async function handleCvVcfToTxtStart(ctx, userId) {
    setState(userId, { mode: 'cv_vcf_to_txt', files: [], fileNames: [], collecting: true });
    await safeReply(ctx, `📥 *Mengumpulkan file VCF...*\n\nKirim file lain atau ketik /done`);
}

async function handleCvVcfToTxtFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.vcf';
    if (!fname.toLowerCase().endsWith('.vcf')) {
        return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    }
    if (state.files.length >= MAX_FILES_PER_BATCH) {
        return safeReply(ctx, `❌ Maksimal ${MAX_FILES_PER_BATCH} file per batch.`);
    }
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
    try {
        const fileList = state.fileNames.map((f, i) => `${i+1}. ${f}`).join('\n');
        await safeReply(ctx, `📥 *${state.files.length} file diterima:*\n\n${fileList}\n\n${'─'.repeat(30)}\n⏳ Memproses konversi...`);
        
        const results = [];
        for (const file of state.files) {
            const contacts   = parseVCF(file.content);
            const baseName   = file.name.replace(/\.vcf$/i, '');
            const txtContent = contacts.map(c => c.phone).join('\n');
            const txtBuffer  = Buffer.from(txtContent, 'utf-8');
            await sendFile(ctx, txtBuffer, `${baseName}.txt`, `✅ ${file.name} → ${baseName}.txt (${contacts.length} nomor)`);
            results.push(`✅ ${file.name} → ${baseName}.txt (${contacts.length} nomor)`);
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
    if (!XLSX) {
        return safeReply(ctx, '❌ Fitur XLSX → VCF memerlukan package xlsx.\n\nAdmin perlu install:\n`npm install xlsx`');
    }
    setState(userId, { mode: 'cv_xlsx_to_vcf', waiting: true });
    await safeReply(ctx, `📊 *XLSX → VCF*\n\nSilakan kirim file .xlsx.\nBot akan memindai semua cell dan mengambil nomor telepon yang valid.\n\nKetik /batal untuk membatalkan.`);
}

async function handleCvXlsxToVcfFile(ctx, userId, state, doc) {
    if (!XLSX) {
        return safeReply(ctx, '❌ Package xlsx tidak terinstall. Hubungi admin.');
    }
    
    const fname = doc.file_name || 'file.xlsx';
    if (!fname.toLowerCase().endsWith('.xlsx')) {
        return safeReply(ctx, '⚠️ Hanya file .xlsx yang diterima.');
    }
    try {
        const buffer   = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
        const workbook = XLSX.read(buffer, { type: 'buffer' });

        let allNumbers = [];
        let totalCells = 0;

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

        const seen          = new Set();
        const uniqueNumbers = [];
        let dupCount        = 0;
        for (const num of allNumbers) {
            if (seen.has(num)) { dupCount++; continue; }
            seen.add(num);
            uniqueNumbers.push(num);
        }

        const contacts   = uniqueNumbers.map(num => ({ name: `Kontak ${num}`, phone: num }));
        const vcfContent = generateVCF(contacts);
        const baseName   = fname.replace(/\.xlsx$/i, '');
        const vcfBuffer  = Buffer.from(vcfContent, 'utf-8');

        const infoText = `📊 HASIL KONVERSI XLSX → VCF\n${'─'.repeat(30)}\n📋 File : ${fname}\n🔢 Cell dipindai : ${totalCells}\n📞 Nomor ditemukan : ${allNumbers.length}\n🚫 Duplikat : ${dupCount}\n✅ Kontak unik : ${uniqueNumbers.length}`;
        await sendFile(ctx, vcfBuffer, `${baseName}.vcf`, infoText);
        clearState(userId);
    } catch (err) {
        log('ERROR', 'CvXlsxToVcf', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
        clearState(userId);
    }
}

// --- 4. TXT2VCF Auto-Detect ---
async function handleTxt2VcfStart(ctx, userId) {
    setState(userId, { mode: 'txt2vcf', waiting: true });
    await safeReply(ctx, `📝 *TXT2VCF Auto-Detect*\n\nKirim file .txt untuk langsung dikonversi menjadi VCF.\n\nFormat yang didukung:\n• Nomor di depan: \`08123 Nama\`\n• Nama di depan: \`Nama 08123\`\n• Separator: \`Nama|08123\` atau \`Nama,08123\`\n• Hanya nomor: \`081234567890\`\n\nKetik /batal untuk membatalkan.`);
}

async function handleTxt2VcfFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.txt';
    if (!fname.toLowerCase().endsWith('.txt')) {
        return safeReply(ctx, '⚠️ Hanya file .txt yang diterima.');
    }
    try {
        const buffer      = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
        const textContent = buffer.toString('utf-8');
        const contacts    = parseTxtLines(textContent);

        if (contacts.length === 0) {
            return safeReply(ctx, '❌ Tidak ada nomor telepon valid yang ditemukan.');
        }

        const baseName   = fname.replace(/\.txt$/i, '');
        const vcfContent = generateVCF(contacts);
        const vcfBuffer  = Buffer.from(vcfContent, 'utf-8');
        await sendFile(ctx, vcfBuffer, `${baseName}.vcf`, `✅ ${fname} → ${baseName}.vcf\n👤 ${contacts.length} kontak unik`);
        clearState(userId);
    } catch (err) {
        log('ERROR', 'Txt2Vcf', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
        clearState(userId);
    }
}

// --- 5. Gabung TXT ---
async function handleGabungTxtStart(ctx, userId) {
    setState(userId, { mode: 'gabungtxt', files: [], fileNames: [], collecting: true });
    await safeReply(ctx, `📥 *Mengumpulkan file TXT...*\n\nKirim file lain atau ketik /done`);
}

async function handleGabungTxtFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.txt';
    if (!fname.toLowerCase().endsWith('.txt')) {
        return safeReply(ctx, '⚠️ Hanya file .txt yang diterima.');
    }
    if (state.files.length >= MAX_FILES_PER_BATCH) {
        return safeReply(ctx, `❌ Maksimal ${MAX_FILES_PER_BATCH} file per batch.`);
    }
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

        const dupCount   = allLines.length - merged.length;
        const txtContent = merged.join('\n');
        const txtBuffer  = Buffer.from(txtContent, 'utf-8');

        const infoText = `📄 HASIL GABUNG TXT\n${'─'.repeat(30)}\n📁 File digabung : ${state.files.length}\n📝 Total baris : ${totalLines}\n🚫 Duplikat : ${dupCount}\n✅ Baris unik : ${merged.length}`;
        await sendFile(ctx, txtBuffer, 'gabungan.txt', infoText);
        clearState(userId);
    } catch (err) {
        log('ERROR', 'GabungTxt', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
        clearState(userId);
    }
}

// --- 6. Gabung VCF ---
async function handleGabungVcfStart(ctx, userId) {
    setState(userId, { mode: 'gabungvcf', files: [], fileNames: [], collecting: true });
    await safeReply(ctx, `📥 *Mengumpulkan file VCF...*\n\nKirim file lain atau ketik /done`);
}

async function handleGabungVcfFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.vcf';
    if (!fname.toLowerCase().endsWith('.vcf')) {
        return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    }
    if (state.files.length >= MAX_FILES_PER_BATCH) {
        return safeReply(ctx, `❌ Maksimal ${MAX_FILES_PER_BATCH} file per batch.`);
    }
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
    try {
        const fileList = state.fileNames.map((f, i) => `${i+1}. ${f}`).join('\n');
        await safeReply(ctx, `📥 *${state.files.length} file diterima:*\n\n${fileList}\n\n${'─'.repeat(30)}\n⏳ Memproses penggabungan...`);
        
        const allContacts = [];
        const seen        = new Set();
        let totalContacts = 0;
        let dupCount      = 0;

        for (const file of state.files) {
            const contacts = parseVCF(file.content);
            totalContacts += contacts.length;
            for (const c of contacts) {
                if (seen.has(c.phone)) { dupCount++; continue; }
                seen.add(c.phone);
                allContacts.push(c);
            }
        }

        const vcfContent = generateVCF(allContacts);
        const vcfBuffer  = Buffer.from(vcfContent, 'utf-8');

        const infoText = `📄 HASIL GABUNG VCF\n${'─'.repeat(30)}\n📁 File digabung : ${state.files.length}\n📝 Total kontak : ${totalContacts}\n🚫 Duplikat : ${dupCount}\n✅ Kontak unik : ${allContacts.length}`;
        await sendFile(ctx, vcfBuffer, 'gabungan.vcf', infoText);
        clearState(userId);
    } catch (err) {
        log('ERROR', 'GabungVcf', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
        clearState(userId);
    }
}

// --- 7. Pecah VCF (bagian) ---
async function handlePecahFileStart(ctx, userId) {
    setState(userId, { mode: 'pecahfile', waiting: true });
    await safeReply(ctx, `✂️ *PECAH VCF (BAGIAN)*\n\nSilakan kirim file .vcf yang ingin dipecah.\n\nKetik /batal untuk membatalkan.`);
}

async function handlePecahFileVcf(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.vcf';
    if (!fname.toLowerCase().endsWith('.vcf')) {
        return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    }
    try {
        const buffer   = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
        const vcfText  = buffer.toString('utf-8');
        const contacts = parseVCF(vcfText);

        if (contacts.length < 2) {
            return safeReply(ctx, '❌ Minimal 2 kontak untuk dipecah.');
        }

        const baseName = fname.replace(/\.vcf$/i, '');
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✂️ 2 Bagian', 'pecahfile_2'), Markup.button.callback('✂️ 3 Bagian', 'pecahfile_3')],
            [Markup.button.callback('✂️ 4 Bagian', 'pecahfile_4'), Markup.button.callback('✂️ 5 Bagian', 'pecahfile_5')],
            [Markup.button.callback('❌ Batal', 'pecahfile_cancel')],
        ]);

        setState(userId, { mode: 'pecahfile', phase: 'choose_parts', contacts, baseName });
        await safeReply(ctx, `📋 *File:* ${fname}\n📊 *Total kontak:* ${contacts.length}\n\nPilih jumlah bagian:`, { ...keyboard });
    } catch (err) {
        log('ERROR', 'PecahFile', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
        clearState(userId);
    }
}

// --- 8. Pecah VCF (jumlah kontak) ---
async function handlePecahCtcStart(ctx, userId, jumlah) {
    const count = Math.max(1, Math.min(10000, parseInt(jumlah) || 100));
    setState(userId, { mode: 'pecahctc', countPerFile: count, waiting: true });
    await safeReply(ctx, `✂️ *PECAH VCF (${count} kontak/file)*\n\nSilakan kirim file .vcf yang ingin dipecah.\n\nKetik /batal untuk membatalkan.`);
}

async function handlePecahCtcFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.vcf';
    if (!fname.toLowerCase().endsWith('.vcf')) {
        return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    }
    try {
        const buffer      = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
        const vcfText     = buffer.toString('utf-8');
        const contacts    = parseVCF(vcfText);

        if (contacts.length === 0) {
            return safeReply(ctx, '❌ Tidak ada kontak valid.');
        }

        const countPerFile = state.countPerFile;
        const baseName     = fname.replace(/\.vcf$/i, '');
        const totalParts   = Math.ceil(contacts.length / countPerFile);

        await safeReply(ctx, `📋 *File:* ${fname}\n📊 *Total kontak:* ${contacts.length}\n📏 *Per file:* ${countPerFile} kontak\n📁 *Menjadi:* ${totalParts} bagian\n\n⏳ Memproses...`);

        for (let i = 0; i < totalParts; i++) {
            const partContacts = contacts.slice(i * countPerFile, (i + 1) * countPerFile);
            const vcfContent   = generateVCF(partContacts);
            const vcfBuffer    = Buffer.from(vcfContent, 'utf-8');
            const partNum      = String(i + 1).padStart(3, '0');
            await sendFile(ctx, vcfBuffer, `${baseName}_${partNum}.vcf`, `📄 Bagian ${i + 1}/${totalParts}: ${partContacts.length} kontak`);
        }

        await safeReply(ctx, `✅ File berhasil dipecah menjadi ${totalParts} bagian\n📋 Total kontak: ${contacts.length}\n📏 Per file: ${countPerFile} kontak`);
        clearState(userId);
    } catch (err) {
        log('ERROR', 'PecahCtc', err.message, err);
        await safeReply(ctx, `❌ Error: ${err.message}`);
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
    if (!fname.toLowerCase().endsWith('.vcf')) {
        return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    }
    try {
        const buffer   = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
        const vcfText  = buffer.toString('utf-8');
        const contacts = parseVCF(vcfText);

        if (contacts.length === 0) {
            return safeReply(ctx, '❌ Tidak ada kontak valid dalam file.');
        }

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
    if (!fname.toLowerCase().endsWith('.vcf')) {
        return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    }
    try {
        const buffer   = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
        const vcfText  = buffer.toString('utf-8');
        const contacts = parseVCF(vcfText);

        if (contacts.length === 0) {
            return safeReply(ctx, '❌ Tidak ada kontak valid dalam file.');
        }

        let preview = `📋 *DAFTAR KONTAK*\n${'─'.repeat(30)}\n📇 *File:* ${fname}\n👤 *Total:* ${contacts.length} kontak\n\n`;
        const maxShow = Math.min(30, contacts.length);
        for (let i = 0; i < maxShow; i++) {
            const c = contacts[i];
            preview += `${i + 1}. ${c.name} → ${c.phone}\n`;
        }
        if (contacts.length > 30) {
            preview += `\n... dan ${contacts.length - 30} kontak lainnya`;
        }
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
    if (!fname.toLowerCase().endsWith('.vcf')) {
        return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    }
    try {
        const buffer   = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
        const vcfText  = buffer.toString('utf-8');
        const contacts = parseVCF(vcfText);

        let withName    = 0;
        let withoutName = 0;
        const seenPhone = new Set();
        let dupCount    = 0;

        for (const c of contacts) {
            if (c.name && c.name !== 'Tanpa Nama') withName++;
            else withoutName++;
            if (seenPhone.has(c.phone)) dupCount++;
            else seenPhone.add(c.phone);
        }

        const infoText = `🔢 *HASIL HITUNG KONTAK VCF*\n${'─'.repeat(30)}\n📇 File : ${fname}\n👤 Total kontak : ${contacts.length}\n✅ Punya nama : ${withName}\n❓ Tanpa nama : ${withoutName}\n📞 Nomor unik : ${seenPhone.size}\n🚫 Nomor duplikat : ${dupCount}`;
        await safeReply(ctx, infoText);
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
    if (!fname.toLowerCase().endsWith('.vcf')) {
        return safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    }
    try {
        const buffer   = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
        const vcfText  = buffer.toString('utf-8');
        const contacts = parseVCF(vcfText);

        if (contacts.length === 0) {
            return safeReply(ctx, '❌ Tidak ada kontak valid dalam file.');
        }

        let preview = `📋 *PREVIEW KONTAK*\n${'─'.repeat(30)}\n📇 *File:* ${fname}\n👤 *Total:* ${contacts.length} kontak\n\n`;
        contacts.slice(0, 5).forEach((c, i) => {
            preview += `${i + 1}. ${c.name} → ${c.phone}\n`;
        });
        if (contacts.length > 5) {
            preview += `\n... dan ${contacts.length - 5} kontak lainnya`;
        }
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
    if (!newName || newName.trim().length === 0) {
        return safeReply(ctx, `Format: /renamefile [nama_baru]\n\nContoh: /renamefile arisan_baru`);
    }
    const invalidChars = /[\/\\:*?"<>|]/;
    if (invalidChars.test(newName)) {
        return safeReply(ctx, `❌ Nama file tidak boleh mengandung karakter: / \\ : * ? " < > |`);
    }
    if (newName.length > 100) {
        return safeReply(ctx, `❌ Nama file maksimal 100 karakter.`);
    }
    const trimmedName = newName.trim();
    setState(userId, { mode: 'renamefile', newName: trimmedName, waiting: true });
    await safeReply(ctx, `✏️ *RENAME FILE*\n\nSilakan kirim file yang ingin diganti namanya.\nNama baru: ${trimmedName} (ekstensi akan dipertahankan)\n\nKetik /batal untuk membatalkan.`);
}

async function handleRenameFile(ctx, userId, state, doc) {
    const fname      = doc.file_name || 'file';
    const ext        = path.extname(fname) || '';
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
    if (!isAdmin(userId)) {
        return safeReply(ctx, '⛔ Akses ditolak. Hanya admin.');
    }
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
            return safeReply(ctx, `❌ Batas penyimpanan admin (${MAX_ADMIN_FILES} file) tercapai. Hapus beberapa file terlebih dahulu.`);
        }
    } catch (err) {
        log('ERROR', 'AdminFile', `Gagal baca dir: ${err.message}`);
    }

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

// ========== HANDLER LISTGC ==========
async function handleListGc(ctx) {
    const userId = ctx.from.id;

    if (!isAdmin(userId)) {
        const status = await getUserStatus(userId);
        if (!['regular', 'trial'].includes(status)) {
            return safeReply(ctx, '❌ Akses ditolak. Fitur ini hanya untuk user premium/trial.');
        }
    }

    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) {
        return safeReply(ctx, '❌ Login dulu! Ketik /login');
    }

    try {
        const chats  = await session.sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        groups.sort((a, b) => (b.participants?.length || 0) - (a.participants?.length || 0));

        if (groups.length <= 20) {
            let listText = `📋 DAFTAR GRUP WA\n${'─'.repeat(30)}\n`;
            groups.forEach((g, i) => {
                listText += `${i + 1}. ${g.subject} - ${g.participants?.length || 0} member\n`;
            });
            listText += `${'─'.repeat(30)}\nTotal: ${groups.length} grup`;
            await safeReply(ctx, listText);
        } else {
            let listText = `DAFTAR GRUP WA\n\n`;
            groups.forEach((g, i) => {
                listText += `${i + 1}. ${g.subject} - ${g.participants?.length || 0} member\n`;
            });
            listText += `\nTotal: ${groups.length} grup`;
            const txtBuffer = Buffer.from(listText, 'utf-8');
            await sendFile(ctx, txtBuffer, 'list_grup.txt', `✅ Daftar ${groups.length} grup`);
        }
    } catch (err) {
        await safeReply(ctx, `❌ Error: ${err.message}`);
    }
}

// ========== MIDDLEWARE: STATE TEXT HANDLER ==========
tgBot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !ctx.message?.text) return next();

    const state = getState(userId);
    if (!state) return next();

    if (state.mode === 'addctc' && state.phase === 'waiting_contacts') {
        const input            = ctx.message.text.trim();
        const existingContacts = state.existingContacts;
        const seen             = new Set(existingContacts.map(c => c.phone));
        const lines            = input.split(/\r?\n/);
        const newContacts      = [];
        let added   = 0;
        let skipped = 0;

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

        if (newContacts.length === 0) {
            return safeReply(ctx, `⚠️ Tidak ada kontak baru yang valid. Kirim lagi atau ketik /done.`);
        }

        const allContacts = [...existingContacts, ...newContacts];
        const vcfContent  = generateVCF(allContacts);
        const baseName    = state.fileName.replace(/\.vcf$/i, '');
        const vcfBuffer   = Buffer.from(vcfContent, 'utf-8');

        await sendFile(ctx, vcfBuffer, `${baseName}_updated.vcf`, `✅ ${added} kontak baru ditambahkan\n👤 Total: ${allContacts.length} kontak\n🚫 ${skipped} duplikat dilewati`);
        clearState(userId);
        return;
    }

    if (state.mode === 'delctc' && state.phase === 'waiting_input') {
        const input    = ctx.message.text.trim();
        const contacts = state.contacts;

        try {
            const toDelete = new Set();
            const parts    = input.split(',');
            for (const part of parts) {
                if (part.includes('-')) {
                    const [start, end] = part.split('-').map(n => parseInt(n.trim()));
                    if (isNaN(start) || isNaN(end)) continue;
                    for (let i = Math.max(1, start); i <= Math.min(end, contacts.length); i++) {
                        toDelete.add(i);
                    }
                } else {
                    const num = parseInt(part.trim());
                    if (!isNaN(num) && num >= 1 && num <= contacts.length) toDelete.add(num);
                }
            }

            if (toDelete.size === 0) {
                return safeReply(ctx, '❌ Tidak ada nomor urut yang valid. Format: 1,3,5-8,10');
            }

            const deletedIndices = Array.from(toDelete).sort((a, b) => b - a);
            const newContacts    = [...contacts];
            for (const idx of deletedIndices) newContacts.splice(idx - 1, 1);

            const vcfContent = generateVCF(newContacts);
            const baseName   = state.fileName.replace(/\.vcf$/i, '');
            const vcfBuffer  = Buffer.from(vcfContent, 'utf-8');

            await sendFile(ctx, vcfBuffer, `${baseName}_dihapus.vcf`, `✅ ${toDelete.size} kontak dihapus\nSisa: ${newContacts.length} kontak`);
            clearState(userId);
        } catch (err) {
            log('ERROR', 'DelCtc', err.message, err);
            await safeReply(ctx, `❌ Error: ${err.message}`);
            clearState(userId);
        }
        return;
    }

    if (state.mode === 'totxt' && state.active) {
        const cmd = ctx.message?.text?.startsWith('/');
        if (cmd) {
            const command = ctx.message.text.split(' ')[0].split('@')[0];
            if (command === '/done' || command === '/selesai') return next();
            return safeReply(ctx, '⚠️ Mode pengumpulan pesan aktif. Hanya /done yang diterima.');
        }
        if (state.messages.length >= 500) {
            return safeReply(ctx, '⚠️ Sudah mencapai batas 500 pesan. Ketik /done untuk generate file.');
        }
        state.messages.push(ctx.message.text);
        setState(userId, state);
        await safeReply(ctx, `✅ Pesan ke-${state.messages.length} disimpan. Ketik /done untuk generate file.`);
        return;
    }

    if (state.mode === 'renamectc') {
        const input    = ctx.message.text.trim();
        const contacts = state.contacts;

        if (state.phase === 'input_prefix') {
            try {
                const renamed    = contacts.map(c => ({ name: `${input} ${c.name}`, phone: c.phone }));
                const vcfContent = generateVCF(renamed);
                const baseName   = state.fileName.replace(/\.vcf$/i, '');
                const vcfBuffer  = Buffer.from(vcfContent, 'utf-8');
                await sendFile(ctx, vcfBuffer, `${baseName}_prefix.vcf`, `✅ Prefix "${input}" ditambahkan ke ${contacts.length} kontak`);
                clearState(userId);
            } catch (err) {
                await safeReply(ctx, `❌ Error: ${err.message}`);
                clearState(userId);
            }
            return;
        }

        if (state.phase === 'input_suffix') {
            try {
                const renamed    = contacts.map(c => ({ name: `${c.name} ${input}`, phone: c.phone }));
                const vcfContent = generateVCF(renamed);
                const baseName   = state.fileName.replace(/\.vcf$/i, '');
                const vcfBuffer  = Buffer.from(vcfContent, 'utf-8');
                await sendFile(ctx, vcfBuffer, `${baseName}_suffix.vcf`, `✅ Suffix "${input}" ditambahkan ke ${contacts.length} kontak`);
                clearState(userId);
            } catch (err) {
                await safeReply(ctx, `❌ Error: ${err.message}`);
                clearState(userId);
            }
            return;
        }

        if (state.phase === 'input_numbered') {
            try {
                const renamed    = contacts.map((c, i) => ({ name: `${input} ${i + 1}`, phone: c.phone }));
                const vcfContent = generateVCF(renamed);
                const baseName   = state.fileName.replace(/\.vcf$/i, '');
                const vcfBuffer  = Buffer.from(vcfContent, 'utf-8');
                await sendFile(ctx, vcfBuffer, `${baseName}_numbered.vcf`, `✅ ${contacts.length} kontak di-rename menjadi "${input} 1" sampai "${input} ${contacts.length}"`);
                clearState(userId);
            } catch (err) {
                await safeReply(ctx, `❌ Error: ${err.message}`);
                clearState(userId);
            }
            return;
        }
    }

    return next();
});

// ========== DOCUMENT HANDLER ==========
tgBot.on('document', async (ctx) => {
    const userId = ctx.from.id;
    const doc    = ctx.message.document;

    const state = getState(userId);
    if (state) {
        switch (state.mode) {
            case 'cv_txt_to_vcf':      return handleCvTxtToVcfFile(ctx, userId, state, doc);
            case 'cv_vcf_to_txt':      return handleCvVcfToTxtFile(ctx, userId, state, doc);
            case 'cv_xlsx_to_vcf':     return handleCvXlsxToVcfFile(ctx, userId, state, doc);
            case 'txt2vcf':            return handleTxt2VcfFile(ctx, userId, state, doc);
            case 'gabungtxt':          return handleGabungTxtFile(ctx, userId, state, doc);
            case 'gabungvcf':          return handleGabungVcfFile(ctx, userId, state, doc);
            case 'pecahfile':          return handlePecahFileVcf(ctx, userId, state, doc);
            case 'pecahctc':           return handlePecahCtcFile(ctx, userId, state, doc);
            case 'addctc':             return handleAddCtcFile(ctx, userId, state, doc);
            case 'delctc':             return handleDelCtcFile(ctx, userId, state, doc);
            case 'hitungctc':          return handleHitungCtcFile(ctx, userId, state, doc);
            case 'renamectc':          return handleRenamectcFile(ctx, userId, state, doc);
            case 'renamefile':         return handleRenameFile(ctx, userId, state, doc);
            case 'cvadminfile_upload': return handleAdminFileUploadFile(ctx, userId, state, doc);
        }
    }

    if (!isAdmin(userId)) {
        const status = await getUserStatus(userId);
        if (!['regular', 'trial'].includes(status)) {
            return safeReply(ctx, '❌ Akses ditolak. Fitur ini hanya untuk user premium/trial.');
        }
    }

    const pending = vcfPending.get(userId);
    if (!pending || !pending.waitingFile) return;

    const fname = doc.file_name || '';
    if (!fname.toLowerCase().endsWith('.vcf')) {
        return safeReply(ctx, '⚠️ File harus .vcf');
    }

    await safeReply(ctx, '⏳ Membaca file VCF...');
    try {
        const buffer   = await downloadTelegramFile(ctx, doc.file_id, bytesToMB(doc.file_size));
        const vcfText  = buffer.toString('utf-8');
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
        await safeReply(ctx, `📊 ${contacts.length} kontak ditemukan.\n🎯 Grup: ${pending.groupName}\n\nTambahkan sekarang?`, { ...keyboard });
    } catch (err) {
        vcfPending.delete(userId);
        await safeReply(ctx, `❌ Error: ${err.message}`);
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
            const rekapText   = `📸 REKAP GRUP\n${'─'.repeat(30)}\n📋 Nama Grup : ${groupName}\n👥 Jumlah Member : ${memberCount}\n📅 Di-rekap : ${formatDate(new Date().toISOString())}`;
            clearState(userId);
            return safeReply(ctx, rekapText);
        }

        await safeReply(ctx, `📸 Foto diterima!\n\nBot tidak bisa membaca teks dari gambar.\nSilakan kirim ulang dengan caption format:\nNamaGrup|JumlahMember`);
    }
});

// ========== COMMANDS ==========
tgBot.command('cv_txt_to_vcf',  async (ctx) => handleCvTxtToVcfStart(ctx, ctx.from.id));
tgBot.command('cv_vcf_to_txt',  async (ctx) => handleCvVcfToTxtStart(ctx, ctx.from.id));
tgBot.command('cv_xlsx_to_vcf', async (ctx) => handleCvXlsxToVcfStart(ctx, ctx.from.id));
tgBot.command('txt2vcf',        async (ctx) => handleTxt2VcfStart(ctx, ctx.from.id));
tgBot.command('gabungtxt',      async (ctx) => handleGabungTxtStart(ctx, ctx.from.id));
tgBot.command('gabungvcf',      async (ctx) => handleGabungVcfStart(ctx, ctx.from.id));
tgBot.command('pecahfile',      async (ctx) => handlePecahFileStart(ctx, ctx.from.id));
tgBot.command('addctc',         async (ctx) => handleAddCtcStart(ctx, ctx.from.id));
tgBot.command('delctc',         async (ctx) => handleDelCtcStart(ctx, ctx.from.id));
tgBot.command('hitungctc',      async (ctx) => handleHitungCtcStart(ctx, ctx.from.id));
tgBot.command('totxt',          async (ctx) => handleTotxtStart(ctx, ctx.from.id));
tgBot.command('rekapgroup',     async (ctx) => handleRekapGroup(ctx, ctx.from.id));
tgBot.command('renamectc',      async (ctx) => handleRenamectcStart(ctx, ctx.from.id));
tgBot.command('cvadminfile',    async (ctx) => handleCvAdminFile(ctx, ctx.from.id));

tgBot.command('pecahctc', async (ctx) => {
    const args   = ctx.message.text.split(' ');
    const jumlah = args[1] || '100';
    await handlePecahCtcStart(ctx, ctx.from.id, jumlah);
});

tgBot.command('renamefile', async (ctx) => {
    const args    = ctx.message.text.split(' ');
    args.shift();
    const newName = args.join(' ').trim();
    await handleRenameFileStart(ctx, ctx.from.id, newName);
});

tgBot.command('listgc', async (ctx) => {
    await handleListGc(ctx);
});

tgBot.command(['done', 'selesai'], async (ctx) => {
    const userId = ctx.from.id;
    const state  = getState(userId);
    if (!state) return safeReply(ctx, '❌ Tidak ada proses yang sedang berjalan.');

    switch (state.mode) {
        case 'cv_txt_to_vcf': return finalizeCvTxtToVcf(ctx, userId, state);
        case 'cv_vcf_to_txt': return finalizeCvVcfToTxt(ctx, userId, state);
        case 'gabungtxt':     return finalizeGabungTxt(ctx, userId, state);
        case 'gabungvcf':     return finalizeGabungVcf(ctx, userId, state);
        case 'totxt': {
            if (state.messages.length === 0) {
                clearState(userId);
                return safeReply(ctx, '❌ Tidak ada pesan yang dikumpulkan.');
            }
            const txtContent = state.messages.join('\n');
            const txtBuffer  = Buffer.from(txtContent, 'utf-8');
            await sendFile(ctx, txtBuffer, `pesan_${Date.now()}.txt`, `✅ ${state.messages.length} pesan disimpan`);
            clearState(userId);
            return;
        }
        default:
            clearState(userId);
            return safeReply(ctx, '✅ Proses dibatalkan.');
    }
});

tgBot.command('batal', async (ctx) => {
    clearState(ctx.from.id);
    await safeReply(ctx, '✅ Proses dibatalkan.');
});

tgBot.start(async (ctx) => {
    const userId = ctx.from.id;
    const name   = ctx.from.first_name || 'User';
    const kb     = await getKeyboard(userId);

    await safeReply(ctx, `╔══════════════════════╗\n║  ${BOT_NAME}\n╚══════════════════════╝\n\n👋 Halo ${name}!\n\nBot ini bisa:\n• Kick anggota grup WA\n• Konversi file (TXT, VCF, XLSX)\n• Gabung & pecah file kontak\n• Dan banyak lagi!\n\n🔧 *File Tools* bisa diakses semua orang.\n📱 Fitur WA butuh login & akses.\n\nPilih menu di keyboard bawah 👇`, { ...kb });
});

// ========== HEARS HANDLERS ==========
tgBot.hears('🔧 File Tools', async (ctx) => {
    await safeReply(ctx, `🔧 *FILE TOOLS MENU*\n\nPilih tool yang ingin digunakan:`, { ...KB_FILE_TOOLS });
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
tgBot.hears('➕ Tambah Kontak', async (ctx) => handleAddCtcStart(ctx, ctx.from.id));
tgBot.hears('➖ Hapus Kontak',  async (ctx) => handleDelCtcStart(ctx, ctx.from.id));
tgBot.hears('🔢 Hitung Kontak', async (ctx) => handleHitungCtcStart(ctx, ctx.from.id));
tgBot.hears('✏️ Rename Kontak', async (ctx) => handleRenamectcStart(ctx, ctx.from.id));
tgBot.hears('📸 Rekap Grup',    async (ctx) => handleRekapGroup(ctx, ctx.from.id));
tgBot.hears('📄 Pesan ke TXT',  async (ctx) => handleTotxtStart(ctx, ctx.from.id));
tgBot.hears('📁 Admin File Manager', async (ctx) => handleCvAdminFile(ctx, ctx.from.id));
tgBot.hears('📋 List Grup WA', async (ctx) => handleListGc(ctx));

tgBot.hears('✂️ Pecah VCF (jlh)', async (ctx) => {
    await safeReply(ctx, `Format: /pecahctc [jumlah]\n\nContoh:\n/pecahctc 50`);
});

tgBot.hears('📝 Rename File', async (ctx) => {
    await safeReply(ctx, `Format: /renamefile [nama_baru]\n\nContoh:\n/renamefile arisan_2024`);
});

// ========== INLINE BUTTON HANDLERS ==========
tgBot.action(/^pecahfile_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const parts = parseInt(ctx.match[1]);
    const state = getState(ctx.from.id);
    if (!state || state.mode !== 'pecahfile') return ctx.editMessageText('❌ Session expired.');

    const contacts      = state.contacts;
    const baseName      = state.baseName;
    const totalContacts = contacts.length;
    const perPart       = Math.ceil(totalContacts / parts);

    try {
        for (let i = 0; i < parts; i++) {
            const partContacts = contacts.slice(i * perPart, (i + 1) * perPart);
            if (partContacts.length === 0) break;
            const vcfContent = generateVCF(partContacts);
            const vcfBuffer  = Buffer.from(vcfContent, 'utf-8');
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

tgBot.action('rename_prefix', async (ctx) => {
    await ctx.answerCbQuery();
    const state = getState(ctx.from.id);
    if (!state || state.mode !== 'renamectc') return;
    setState(ctx.from.id, { ...state, phase: 'input_prefix' });
    await safeReply(ctx, '✏️ Masukkan prefix:\n\nContoh: Tim Marketing\n\nHasil: "Tim Marketing Budi"');
});

tgBot.action('rename_suffix', async (ctx) => {
    await ctx.answerCbQuery();
    const state = getState(ctx.from.id);
    if (!state || state.mode !== 'renamectc') return;
    setState(ctx.from.id, { ...state, phase: 'input_suffix' });
    await safeReply(ctx, '✏️ Masukkan suffix:\n\nContoh: (2024)\n\nHasil: "Budi (2024)"');
});

tgBot.action('rename_numbered', async (ctx) => {
    await ctx.answerCbQuery();
    const state = getState(ctx.from.id);
    if (!state || state.mode !== 'renamectc') return;
    setState(ctx.from.id, { ...state, phase: 'input_numbered' });
    await safeReply(ctx, '✏️ Masukkan nama template:\n\nContoh: Member\n\nHasil: "Member 1", "Member 2"');
});

tgBot.action('rename_cancel', async (ctx) => {
    clearState(ctx.from.id);
    await ctx.editMessageText('✖ Rename kontak dibatalkan.');
});

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
        if (files.length === 0) {
            return safeReply(ctx, '📂 Direktori admin kosong.');
        }
        let fileList = `📂 *DAFTAR FILE ADMIN*\n${'─'.repeat(30)}\n`;
        files.forEach((f, i) => {
            const filePath = path.join(ADMIN_FILES_DIR, f);
            const stats    = fs.statSync(filePath);
            const sizeKB   = (stats.size / 1024).toFixed(1);
            fileList += `${i + 1}. ${f} (${sizeKB}KB)\n`;
        });
        fileList += `${'─'.repeat(30)}\nTotal: ${files.length} file`;
        await safeReply(ctx, fileList);
    } catch (err) {
        await safeReply(ctx, `❌ Error: ${err.message}`);
    }
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
        await safeReply(ctx, `🗑️ *HAPUS FILE ADMIN*\n\nPilih file:`, { reply_markup: { inline_keyboard: buttons } });
    } catch (err) {
        await safeReply(ctx, `❌ Error: ${err.message}`);
    }
});

tgBot.action(/^adminfiledel_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
    const idx   = parseInt(ctx.match[1]);
    const state = getState(ctx.from.id);
    if (!state || !state.fileList) return ctx.editMessageText('❌ Session expired.');

    const fileName = state.fileList[idx];
    if (!fileName) return ctx.editMessageText('❌ File tidak ditemukan.');

    try {
        const safeName = safeFilename(fileName);
        fs.unlinkSync(path.join(ADMIN_FILES_DIR, safeName));
        clearState(ctx.from.id);
        await ctx.editMessageText(`✅ File dihapus: ${safeName}`);
    } catch (err) {
        await ctx.editMessageText(`❌ Error: ${err.message}`);
    }
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
        await safeReply(ctx, `📥 *DOWNLOAD FILE ADMIN*\n\nPilih file:`, { reply_markup: { inline_keyboard: buttons } });
    } catch (err) {
        await safeReply(ctx, `❌ Error: ${err.message}`);
    }
});

tgBot.action(/^adminfiledl_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();
    const idx   = parseInt(ctx.match[1]);
    const state = getState(ctx.from.id);
    if (!state || !state.fileList) return ctx.editMessageText('❌ Session expired.');

    const fileName = state.fileList[idx];
    if (!fileName) return ctx.editMessageText('❌ File tidak ditemukan.');

    try {
        const safeName = safeFilename(fileName);
        const filePath = path.join(ADMIN_FILES_DIR, safeName);
        const buffer   = fs.readFileSync(filePath);
        await sendFile(ctx, buffer, safeName, `📥 File: ${safeName}`);
        clearState(ctx.from.id);
    } catch (err) {
        await ctx.editMessageText(`❌ Error: ${esc(err.message)}`);
    }
});

tgBot.action('adminfiledl_cancel', async (ctx) => {
    clearState(ctx.from.id);
    await ctx.editMessageText('✖ Dibatalkan.');
});

tgBot.action('vcf_add_all', async (ctx) => {
    await ctx.answerCbQuery();
    const userId  = ctx.from.id;
    const pending = vcfPending.get(userId);
    if (!pending) return safeReply(ctx, '❌ Session expired. Ulangi proses import.');

    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) {
        vcfPending.delete(userId);
        return safeReply(ctx, '❌ Sesi WA sudah tidak aktif. Silakan login ulang.');
    }

    if (!pending.groupId) {
        vcfPending.delete(userId);
        return safeReply(ctx, '❌ Grup tidak ditemukan. Pilih grup terlebih dahulu.');
    }

    const contacts = pending.contacts || [];
    if (contacts.length === 0) {
        vcfPending.delete(userId);
        return safeReply(ctx, '❌ Tidak ada kontak untuk ditambahkan.');
    }

    await safeReply(ctx, `⏳ Menambahkan ${contacts.length} kontak ke grup ${pending.groupName}...`);

    let successCount = 0;
    let failCount    = 0;
    const batchSize  = 5;

    try {
        for (let i = 0; i < contacts.length; i += batchSize) {
            const batch       = contacts.slice(i, i + batchSize);
            const phoneList   = batch.map(c => `${c.phone}@s.whatsapp.net`);
            try {
                await session.sock.groupParticipantsUpdate(pending.groupId, phoneList, 'add');
                successCount += batch.length;
            } catch (err) {
                failCount += batch.length;
                log('WARN', 'VcfAddAll', `Batch gagal: ${err.message}`);
            }
            if (i + batchSize < contacts.length) {
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        await safeReply(ctx, `✅ Import selesai!\n\n✅ Berhasil: ${successCount}\n❌ Gagal: ${failCount}\n📋 Grup: ${pending.groupName}`);
    } catch (err) {
        log('ERROR', 'VcfAddAll', err.message, err);
        await safeReply(ctx, `❌ Error saat import: ${err.message}`);
    } finally {
        vcfPending.delete(userId);
    }
});

tgBot.action('vcf_cancel', async (ctx) => {
    vcfPending.delete(ctx.from.id);
    await ctx.answerCbQuery('Dibatalkan');
    await safeReply(ctx, '✖ Import dibatalkan.');
});

// ========== HELP ==========
tgBot.command('help', async (ctx) => {
    const helpText = [
        '🤖 WA Kicker Bot - Panduan',
        '',
        '🔧 FILE TOOLS (bisa diakses semua):',
        '/cv_txt_to_vcf - Convert TXT ke VCF',
        '/cv_vcf_to_txt - Convert VCF ke TXT',
        '/cv_xlsx_to_vcf - Convert XLSX ke VCF',
        '/txt2vcf - TXT ke VCF auto-detect',
        '/gabungtxt - Gabung multiple TXT',
        '/gabungvcf - Gabung multiple VCF',
        '/pecahfile - Pecah VCF per bagian',
        '/pecahctc [n] - Pecah VCF per jumlah kontak',
        '/addctc - Tambah kontak ke VCF',
        '/delctc - Hapus kontak dari VCF',
        '/hitungctc - Hitung kontak VCF',
        '/renamectc - Rename kontak VCF',
        '/renamefile [nama] - Rename file',
        '/totxt - Simpan pesan ke TXT',
        '/rekapgroup - Rekap grup dari foto',
        '',
        '📱 FITUR WA (perlu login & akses):',
        '/login - Login WhatsApp',
        '/listgc - List semua grup',
        '/groups - Lihat grup WA',
        '/select - Pilih grup',
        '/buatgrup - Buat grup WA',
        '/importvcf - Import VCF ke grup',
        '/kickmenu - Kick anggota grup',
        '',
        'Ketik /done untuk selesaikan proses.',
        'Ketik /batal untuk batalkan.'
    ].join('\n');

    await safeReply(ctx, helpText);
});

// ========== HEALTH CHECK ==========
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status:    'ok',
            bot:       'WA Kicker Bot v6.3.0',
            uptime:    Math.floor(process.uptime()) + 's',
            timestamp: new Date().toISOString(),
            sessions:  userSessions.size,
            states:    userStates.size,
            xlsxReady: XLSX !== null
        }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status:    'ok',
        uptime:    Math.floor(process.uptime()) + 's',
        timestamp: new Date().toISOString()
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
            log('INFO', 'Shutdown', `Menutup sesi WA user ${userId}`);
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

process.on('unhandledRejection', (reason, promise) => {
    log('ERROR', 'UnhandledRejection', `Promise: ${promise}, Reason: ${reason}`);
});

process.on('uncaughtException', (err) => {
    log('ERROR', 'UncaughtException', err.message, err);
});

tgBot.launch().then(() => {
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║  WA KICKER BOT v6.3.0 - ALL FIXED       ║');
    console.log('║  NO-SPAM + XLSX SUPPORT                  ║');
    console.log('╚══════════════════════════════════════════╝\n');
    console.log(`📋 Admin IDs  : ${ADMIN_IDS.join(', ')}`);
    console.log(`📁 Data dir   : ${DATA_DIR}`);
    console.log(`📦 Max file   : ${MAX_FILE_SIZE_MB}MB`);
    console.log(`👥 Max kontak : ${MAX_CONTACTS_PER_FILE.toLocaleString()}/file`);
    console.log(`⏱️  DL timeout : ${DOWNLOAD_TIMEOUT_MS / 1000}s`);
    console.log(`\n✨ SEMUA FITUR SUDAH DI-FIX:`);
    console.log(`   - TXT → VCF (NO-SPAM)`);
    console.log(`   - VCF → TXT (NO-SPAM)`);
    console.log(`   - GABUNG TXT/VCF (NO-SPAM)`);
    console.log(`   - PECAH VCF (NO-SPAM)`);
    console.log(`   - TAMBAH/HAPUS KONTAK (NO-SPAM)`);
    console.log(`   - RENAME KONTAK (NO-SPAM)`);
    console.log(`   - XLSX → VCF: ${XLSX ? '✅ AKTIF' : '❌ INSTALL xlsx'}`);
    console.log(`\n🚀 Bot siap digunakan!\n`);
}).catch(err => {
    console.error('❌ Gagal launch bot:', err.message);
    process.exit(1);
});
