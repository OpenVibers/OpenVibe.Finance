'use strict';
/**
 * A receipt photo → a transaction to check (plan §L.2: "receipt photos … always free"). The picture is read on this
 * server by Tesseract (the same local reader OpenVibe Vision uses first), from memory to memory: it is never written to
 * disk, sent anywhere, or kept. The person checks the store, the day and the total before anything is added.
 *
 *   ocr(buffer, { timeoutMs }) → text   (tesseract stdin stdout; throws ReceiptError when it cannot read)
 *   readReceipt(text, { today }) → { payee, posted_on, amount_cents, found: { payee, date, total } }
 *     amount_cents is money out (negative); null when no total was found. found says which parts were read, so the page
 *     can say what to check.
 */
const { spawn } = require('node:child_process');

class ReceiptError extends Error {}

function ocr(buffer, { timeoutMs = 20000, bin = '/usr/bin/tesseract' } = {}) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(bin, ['stdin', 'stdout', '-l', 'eng', '--psm', '6'], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', OMP_THREAD_LIMIT: '1' } });
        } catch { return reject(new ReceiptError('The receipt reader is not available on this server.')); }
        const out = [];
        let size = 0;
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new ReceiptError('Reading the receipt took too long. Try a closer, sharper photo.')); }, timeoutMs);
        child.stdout.on('data', (d) => { size += d.length; if (size < 512 * 1024) out.push(d); });
        child.stderr.on('data', () => {});
        child.on('error', () => { clearTimeout(timer); reject(new ReceiptError('The receipt reader is not available on this server.')); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) return reject(new ReceiptError('That photo could not be read. A JPEG or PNG of the whole receipt works best.'));
            resolve(Buffer.concat(out).toString('utf8'));
        });
        child.stdin.on('error', () => {});
        child.stdin.end(buffer);
    });
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONEY = /(-)?[$£€]?\s?(\d{1,3}(?:[,\s]\d{3})*|\d+)[.,](\d{2})(?!\d)/g;
const TOTAL = /\b(grand\s+total|total\s+due|amount\s+due|balance\s+due|total)\b/i;
const NOT_TOTAL = /\b(sub\s*-?\s*total|tax|savings|discount|you\s+saved|items?\s+sold|tip|change)\b/i;
const NOT_PAYEE = /\b(receipt|welcome|thank|store\s*#|tel|phone|www\.|http|cashier|register|order|invoice|date|time)\b/i;
const pad = (n) => String(n).padStart(2, '0');
const realDay = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };

function dateOf(text, today) {
    const s = String(text || '');
    const tries = [
        [/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/, (m) => [+m[1], +m[2], +m[3]]],
        [/\b(\d{1,2})[/.-](\d{1,2})[/.-](20\d{2}|\d{2})\b/, (m) => { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return +m[1] > 12 ? [y, +m[2], +m[1]] : [y, +m[1], +m[2]]; }],
        [/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})\b/i, (m) => [+m[3], MONTHS[m[1].toLowerCase().slice(0, 3)], +m[2]]],
        [/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+(20\d{2})\b/i, (m) => [+m[3], MONTHS[m[2].toLowerCase().slice(0, 3)], +m[1]]],
    ];
    for (const [re, pick] of tries) {
        const m = re.exec(s);
        if (!m) continue;
        const [y, mo, d] = pick(m);
        if (realDay(y, mo, d) && `${y}-${pad(mo)}-${pad(d)}` <= today) return `${y}-${pad(mo)}-${pad(d)}`;
    }
    return null;
}

const amountsOf = (line) => [...String(line).matchAll(MONEY)].map((m) => Number(m[2].replace(/[,\s]/g, '')) * 100 + Number(m[3]));

function readReceipt(text, { today = new Date().toISOString().slice(0, 10) } = {}) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    // The total: the first line that says total (never a subtotal, tax or change) with an amount; else the largest
    // amount on the receipt.
    let total = null;
    for (const l of lines) {
        if (!TOTAL.test(l) || NOT_TOTAL.test(l)) continue;
        const a = amountsOf(l);
        if (a.length) { total = a[a.length - 1]; break; }
    }
    let foundTotal = total != null;
    if (total == null) {
        const all = lines.flatMap(amountsOf).filter((c) => c > 0 && c < 1e8);
        if (all.length) total = Math.max(...all);
    }
    // The store: the first of the top lines that reads as a name (letters, not an address or a greeting).
    const payee = lines.slice(0, 6).find((l) => /[A-Za-z]{3,}/.test(l) && !NOT_PAYEE.test(l) && !/^\d/.test(l) && (l.match(/\d/g) || []).length < l.length / 3) || '';
    const date = dateOf(lines.join('\n'), today);
    return {
        payee: payee.slice(0, 60), posted_on: date || today, amount_cents: total == null ? null : -total,
        found: { payee: Boolean(payee), date: Boolean(date), total: foundTotal },
    };
}

module.exports = { ocr, readReceipt, ReceiptError };
