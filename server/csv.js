'use strict';
/**
 * A bank's CSV export → transactions (plan §L.2: "manual entry, CSV … always free").
 *
 *   readCsv(text) → { rows: [{ posted_on, amount_cents, payee, memo, category }], columns, skipped: [{ line, why }] }
 *
 * What banks send differs, so this reads the file rather than a fixed layout:
 *   - the delimiter: comma, semicolon or tab, whichever splits the header into the most columns;
 *   - quoted fields with commas, doubled quotes and line breaks inside;
 *   - the columns by their header: a date, then either one signed amount or a debit and a credit, a payee or
 *     description, a memo, a category;
 *   - dates as 2026-11-18, 11/18/2026, 18/11/2026 (day first when a day over 12 says so, or when the file is
 *     day-first throughout), 18.11.2026, 2026/11/18, and "Nov 18, 2026";
 *   - amounts as -12.34, (12.34), $1,234.56, 1.234,56 (comma decimals), 12.34 CR / DR.
 * A row that cannot be read is skipped and said, never guessed.
 */

const MAX_ROWS = 20000;

function splitRows(text, delim) {
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
            else cell += c;
        } else if (c === '"' && cell === '') quoted = true;
        else if (c === delim) { row.push(cell); cell = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(cell); cell = '';
            if (row.length > 1 || row[0].trim() !== '') rows.push(row);
            row = [];
            if (rows.length > MAX_ROWS + 1) break;
        } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); if (row.length > 1 || row[0].trim() !== '') rows.push(row); }
    return rows;
}

const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z]/g, '');
const HEADERS = {
    date: ['date', 'transactiondate', 'posteddate', 'postingdate', 'bookingdate', 'valuedate', 'transdate', 'datum'],
    amount: ['amount', 'transactionamount', 'amountusd', 'value', 'betrag', 'montant', 'sum'],
    debit: ['debit', 'debitamount', 'withdrawal', 'withdrawals', 'moneyout', 'paidout', 'outflow', 'charge'],
    credit: ['credit', 'creditamount', 'deposit', 'deposits', 'moneyin', 'paidin', 'inflow', 'payment'],
    payee: ['payee', 'description', 'name', 'merchant', 'merchantname', 'details', 'transactiondescription', 'narrative', 'counterparty', 'originaldescription'],
    memo: ['memo', 'notes', 'note', 'reference', 'comment', 'extendeddescription'],
    category: ['category', 'categoryname'],
};

function columnsOf(header) {
    const n = header.map(norm);
    const pick = (names) => { for (const name of names) { const i = n.indexOf(name); if (i >= 0) return i; } return -1; };
    const cols = {};
    for (const [k, names] of Object.entries(HEADERS)) cols[k] = pick(names);
    // "Description" as the payee when there is no payee column; otherwise the description is the memo.
    if (cols.payee >= 0 && cols.memo < 0) {
        const desc = n.indexOf('description');
        if (desc >= 0 && desc !== cols.payee) cols.memo = desc;
    }
    return cols;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
const valid = (y, m, d) => {
    if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
};
/** One date → 'YYYY-MM-DD' or null. `dayFirst`: read 01/02/2026 as the 1st of February. */
function readDate(s, dayFirst = false) {
    const t = String(s || '').trim();
    let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(t);
    if (m) return valid(+m[1], +m[2], +m[3]);
    m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(t);
    if (m) {
        let y = +m[3]; if (y < 100) y += 2000;
        const a = +m[1], b = +m[2];
        const sep = t.includes('.') ? '.' : null;
        const df = dayFirst || sep === '.' || a > 12;
        return df ? valid(y, b, a) : valid(y, a, b);
    }
    m = /^([A-Za-z]{3,4})[a-z]*\.? (\d{1,2}),? (\d{4})$/.exec(t);
    if (m && MONTHS[m[1].toLowerCase()]) return valid(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
    m = /^(\d{1,2}) ([A-Za-z]{3,4})[a-z]*\.? (\d{4})$/.exec(t);
    if (m && MONTHS[m[2].toLowerCase()]) return valid(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
    return null;
}

/** One amount → integer cents (signed) or null. */
function readAmount(s) {
    let t = String(s == null ? '' : s).trim();
    if (!t) return null;
    let sign = 1;
    if (/^\(.*\)$/.test(t)) { sign = -1; t = t.slice(1, -1); }
    if (/\bDR$/i.test(t)) { sign = -1; t = t.replace(/\s*DR$/i, ''); }
    t = t.replace(/\s*CR$/i, '');
    t = t.replace(/[^\d.,\-+]/g, '');
    if (t.startsWith('-')) { sign = -sign; t = t.slice(1); } else if (t.startsWith('+')) t = t.slice(1);
    if (t.endsWith('-')) { sign = -sign; t = t.slice(0, -1); }
    if (!/\d/.test(t)) return null;
    // 1.234,56 or 12,34: a comma decimal when the last separator is a comma followed by 1-2 digits.
    const lastComma = t.lastIndexOf(','), lastDot = t.lastIndexOf('.');
    if (lastComma > lastDot && /,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
    else t = t.replace(/,/g, '');
    if (!/^\d+(\.\d+)?$/.test(t)) return null;
    const [whole, frac = ''] = t.split('.');
    const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2)) + (Number(frac[2] || 0) >= 5 ? 1 : 0);
    return Number.isSafeInteger(cents) ? sign * cents : null;
}

function readCsv(text) {
    const src = String(text || '').replace(/^﻿/, '');
    const firstLine = src.split(/\r?\n/, 1)[0] || '';
    const delim = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const all = splitRows(src, delim);
    if (all.length < 2) return { rows: [], columns: null, skipped: [], problem: 'The file has no rows under its header.' };
    const header = all[0];
    const cols = columnsOf(header);
    if (cols.date < 0) return { rows: [], columns: cols, skipped: [], problem: 'No date column: the header needs a column named Date (or Posted Date, Transaction Date).' };
    if (cols.amount < 0 && cols.debit < 0 && cols.credit < 0) return { rows: [], columns: cols, skipped: [], problem: 'No amount column: the header needs Amount, or Debit and Credit.' };
    const body = all.slice(1, MAX_ROWS + 1);
    // Day first when any date's first number is over 12 (and none's second is): the file is one layout throughout.
    let dayFirst = false;
    for (const r of body) {
        const m = /^(\d{1,2})[/-](\d{1,2})[/-]\d{2,4}$/.exec(String(r[cols.date] || '').trim());
        if (m && +m[1] > 12) { dayFirst = true; break; }
    }
    const rows = [], skipped = [];
    body.forEach((r, i) => {
        const line = i + 2;
        const posted_on = readDate(r[cols.date], dayFirst);
        if (!posted_on) { skipped.push({ line, why: `the date "${String(r[cols.date] || '').slice(0, 30)}" is not one this reads` }); return; }
        let amount = null;
        if (cols.amount >= 0) amount = readAmount(r[cols.amount]);
        if (amount == null && (cols.debit >= 0 || cols.credit >= 0)) {
            const out = cols.debit >= 0 ? readAmount(r[cols.debit]) : null;
            const inn = cols.credit >= 0 ? readAmount(r[cols.credit]) : null;
            if (out != null || inn != null) amount = (inn != null ? Math.abs(inn) : 0) - (out != null ? Math.abs(out) : 0);
        }
        if (amount == null) { skipped.push({ line, why: 'no amount' }); return; }
        const text = (k) => (cols[k] >= 0 ? String(r[cols[k]] || '').replace(/\s+/g, ' ').trim().slice(0, 300) : '');
        rows.push({ posted_on, amount_cents: amount, payee: text('payee'), memo: text('memo'), category: text('category').slice(0, 60) });
    });
    return { rows, columns: cols, skipped, problem: rows.length ? null : 'No row could be read.' };
}

module.exports = { readCsv, readDate, readAmount, splitRows, columnsOf };
