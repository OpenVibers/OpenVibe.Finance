'use strict';
/**
 * A statement's lines → transactions (plan §L.2: "statement PDFs … always free"). A bank or card statement lists one
 * transaction a line: a date first, then the description, then the amount (and often the running balance last).
 *
 *   readStatement(text, { today }) → { rows: [{ posted_on, amount_cents, payee, memo: '', category: '', signed }],
 *                                       signs, year, problem }
 *     signs: 'explicit' when the statement marks money out (a minus, brackets, DR) and in (CR); else 'guessed' (every
 *            amount positive: a word such as deposit, payroll, refund or payment received reads as money in, the rest
 *            as money out). The person checks them in the preview before anything is imported.
 *
 * Dates: 2026-11-02, 11/02/2026, 02.11.26, 11/02 (the statement's year), 2 Nov 2026, Nov 2. Day first when any date's
 * first part is over 12 (or the text uses £ or €), month first otherwise. Summary lines (balances, totals) are skipped.
 */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MON = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*\\.?';
const DATES = [
    { re: /^(\d{4})-(\d{1,2})-(\d{1,2})\b/, pick: (m) => ({ y: +m[1], a: +m[2], b: +m[3], iso: true }) },
    { re: /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/, pick: (m) => ({ a: +m[1], b: +m[2], y: m[3].length === 2 ? 2000 + +m[3] : +m[3] }) },
    { re: /^(\d{1,2})[/.-](\d{1,2})(?![/.\-\d])/, pick: (m) => ({ a: +m[1], b: +m[2], y: null }) },
    { re: new RegExp(`^(\\d{1,2})\\s+${MON}(?:,?\\s+(\\d{4}))?\\b`, 'i'), pick: (m) => ({ d: +m[1], mo: MONTHS[m[2].toLowerCase().slice(0, 3)], y: m[3] ? +m[3] : null }) },
    { re: new RegExp(`^${MON}\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?\\b`, 'i'), pick: (m) => ({ d: +m[2], mo: MONTHS[m[1].toLowerCase().slice(0, 3)], y: m[3] ? +m[3] : null }) },
];
const MONEY = /(?:^|\s)(-|\()?\s?[$£€]?\s?(\d{1,3}(?:[,\s]\d{3})*|\d+)[.,](\d{2})\)?(?:\s?(CR|DR|-))?(?=\s|$)/gi;
const SUMMARY = /\b(opening|closing|previous|new|beginning|ending|available|statement)\s+balance\b|\bbalance\s+(forward|brought|carried)\b|^total\b|\bsubtotal\b|\bminimum payment\b|\bpayment due\b/i;
const INWARD = /\b(deposit|payroll|salary|direct dep|refund|reversal|interest (paid|earned)|payment (received|thank you)|thank you payment|transfer from|credit)\b/i;

const pad = (n) => String(n).padStart(2, '0');
const realDay = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };

function readStatement(text, { today = new Date().toISOString().slice(0, 10) } = {}) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    // The statement's year, for dates printed without one: the most common 20xx in the text, else this year.
    const years = {};
    for (const y of String(text || '').match(/\b20\d{2}\b/g) || []) years[y] = (years[y] || 0) + 1;
    const year = Number(Object.entries(years).sort((x, y) => y[1] - x[1])[0]?.[0]) || Number(today.slice(0, 4));
    const found = [];
    for (const line of lines) {
        let date = null;
        let rest = null;
        for (const f of DATES) {
            const m = f.re.exec(line);
            if (m) { date = f.pick(m); rest = line.slice(m[0].length).trim(); break; }
        }
        if (!date || !rest) continue;
        // A second date (posting after transaction date) is not part of the payee.
        for (const f of DATES) { const m = f.re.exec(rest); if (m) { rest = rest.slice(m[0].length).trim(); break; } }
        const money = [...rest.matchAll(MONEY)];
        if (!money.length) continue;
        // The amount: the last money on the line, or the one before it when the line also ends with the balance.
        const pick = money.length >= 2 ? money[money.length - 2] : money[money.length - 1];
        const payee = rest.slice(0, pick.index).replace(/\s+/g, ' ').trim().replace(/[\s:–-]+$/, '');
        if (!payee || SUMMARY.test(payee)) continue;
        const cents = Number(pick[2].replace(/[,\s]/g, '')) * 100 + Number(pick[3]);
        const mark = (pick[4] || '').toUpperCase();
        const minus = pick[1] === '-' || pick[1] === '(' || mark === 'DR' || mark === '-';
        const plus = mark === 'CR';
        found.push({ date, payee: payee.slice(0, 300), cents, minus, plus });
    }
    if (!found.length) return { rows: [], signs: 'guessed', year, problem: 'No lines with a date and an amount were found in this statement.' };
    const dayFirst = /[£€]/.test(String(text || '')) || found.some((f) => f.date.a > 12);
    const rows = [];
    for (const f of found) {
        let y = f.date.y || year, mo, d;
        if (f.date.iso) { mo = f.date.a; d = f.date.b; }
        else if (f.date.mo) { mo = f.date.mo; d = f.date.d; }
        else if (dayFirst) { d = f.date.a; mo = f.date.b; }
        else { mo = f.date.a; d = f.date.b; }
        if (!realDay(y, mo, d)) continue;
        rows.push({ posted_on: `${y}-${pad(mo)}-${pad(d)}`, cents: f.cents, payee: f.payee, minus: f.minus, plus: f.plus });
    }
    const explicit = rows.some((r) => r.minus || r.plus);
    return {
        signs: explicit ? 'explicit' : 'guessed', year, problem: rows.length ? null : 'No line had a real date.',
        rows: rows.slice(0, 2000).map((r) => {
            const inward = explicit ? !r.minus : INWARD.test(r.payee);
            return { posted_on: r.posted_on, amount_cents: inward ? r.cents : -r.cents, payee: r.payee, memo: '', category: '', signed: explicit };
        }),
    };
}

module.exports = { readStatement };
