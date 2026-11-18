'use strict';
/**
 * A bank's OFX or QFX download → transactions (plan §L.2: "manual entry, CSV, OFX, QFX … always free").
 *
 *   isOfx(text)  → true for an OFX 1.x (SGML, "OFXHEADER:100") or 2.x (XML, "<?OFX") file, Quicken's QFX included
 *   readOfx(text) → { rows: [{ posted_on, amount_cents, payee, memo, category: '', fitid }], currency, skipped, problem }
 *
 * Both versions are read the same way: each <STMTTRN> … </STMTTRN> block (bank and credit-card statements), its
 * fields as <TAG>value, closed or not (OFX 1.x leaves leaf tags open). FITID is the bank's own id for a transaction:
 * the import keeps it, so the same download twice, or two overlapping ones, add each transaction once.
 */
const { readAmount } = require('./csv');

const isOfx = (text) => /^\s*(?:﻿)?(?:OFXHEADER\s*:|<\?xml[^>]*>\s*<\?OFX|<\?OFX|<OFX>)/i.test(String(text || '')) || /<OFX>[\s\S]*<STMTTRN>/i.test(String(text || '').slice(0, 200000));

const decode = (v) => String(v || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/\s+/g, ' ').trim();

/** One leaf field of a block: <TAG>value, ended by its closing tag, the next tag, or the line. */
function field(block, tag) {
    const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(block);
    return m ? decode(m[1]) : '';
}

/** An OFX date (20261118, 20261118120000, 20261118120000.000[-5:EST]) → 'YYYY-MM-DD' or null. */
function ofxDate(v) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(v || '').trim());
    if (!m) return null;
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    const t = new Date(Date.UTC(y, mo - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function readOfx(text) {
    const src = String(text || '');
    const currency = field(src, 'CURDEF') || null;
    const blocks = src.split(/<STMTTRN>/i).slice(1).map((b) => b.split(/<\/STMTTRN>/i)[0]);
    if (!blocks.length) return { rows: [], currency, skipped: [], problem: 'No transactions in this file (no <STMTTRN> blocks).' };
    const rows = [], skipped = [];
    blocks.slice(0, 20000).forEach((b, i) => {
        const posted_on = ofxDate(field(b, 'DTPOSTED')) || ofxDate(field(b, 'DTUSER'));
        const amount_cents = readAmount(field(b, 'TRNAMT'));
        if (!posted_on) { skipped.push({ line: i + 1, why: 'no posted date' }); return; }
        if (amount_cents == null) { skipped.push({ line: i + 1, why: 'no amount' }); return; }
        const name = field(b, 'NAME') || field(b, 'PAYEE');
        const memo = field(b, 'MEMO');
        rows.push({ posted_on, amount_cents, payee: (name || memo).slice(0, 300), memo: name ? memo.slice(0, 500) : '', category: '', fitid: field(b, 'FITID').slice(0, 255) || null });
    });
    return { rows, currency, skipped, problem: rows.length ? null : 'No transaction in this file could be read.' };
}

module.exports = { isOfx, readOfx, ofxDate };
