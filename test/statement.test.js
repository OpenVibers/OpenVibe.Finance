'use strict';
/**
 * Statement PDFs (v0.11; server/pdf.js, server/statement.js): a text PDF read here, plain or Flate-compressed; lines with
 * a date and an amount (a running balance at the end skipped; minus, brackets, DR and CR; dates with and without a year,
 * day first with £ or a day over 12); balances and totals skipped; amounts that are all positive guessed by their words
 * and checked by the person; the preview, the ticked rows imported, the same statement twice adding nothing, and the
 * refusals (not a PDF, no lines, another person's account, a cross-site post).
 */
const assert = require('assert');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { pdfText } = require('../server/pdf');
const { readStatement } = require('../server/statement');

const esc = (s) => s.replace(/[()\\]/g, (m) => `\\${m}`);
function pdf(lines, { deflate = false } = {}) {
    const content = `BT /F1 10 Tf 40 760 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
    const data = deflate ? zlib.deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1');
    return Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj << /Length ${data.length}${deflate ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1')]);
}

const CARD = ['ACME BANK  Statement period Nov 1 - Nov 30, 2026', 'Opening balance 1,000.00', '11/02 CORNER GROCER #44 -23.18 976.82',
    '11/03 PAYROLL ACME CORP 3,120.00 4,096.82', '11/05 STREAMFLIX (15.99) 4,080.83', 'Nov 7 COFFEE SHOP 4.75 DR', '12 Nov 2026 REFUND SHOES 20.00 CR',
    'Closing balance 4,060.08', 'Total fees 0.00'];

// ── The PDF's text ──
for (const deflate of [false, true]) {
    const t = pdfText(pdf(CARD, { deflate }));
    assert.strictEqual(t.pages.length, 1, `deflate ${deflate}`);
    assert.match(t.pages[0], /11\/05 STREAMFLIX \(15\.99\) 4,080\.83/);
}
assert.match(pdfText(Buffer.from('Date,Amount\n')).reason, /not a PDF/);
assert.match(pdfText(Buffer.from('%PDF-1.4\n/Encrypt 5 0 R\n')).reason, /encrypted/);
assert.match(pdfText(Buffer.from('%PDF-1.4\n1 0 obj << /Filter /DCTDecode >>\nstream\nxx\nendstream\n')).reason, /no readable text/);

// ── The lines ──
let r = readStatement(CARD.join('\n'), { today: '2026-11-18' });
assert.strictEqual(r.signs, 'explicit');
assert.deepStrictEqual(r.rows.map((x) => [x.posted_on, x.amount_cents, x.payee]), [
    ['2026-11-02', -2318, 'CORNER GROCER #44'], ['2026-11-03', 312000, 'PAYROLL ACME CORP'], ['2026-11-05', -1599, 'STREAMFLIX'],
    ['2026-11-07', -475, 'COFFEE SHOP'], ['2026-11-12', 2000, 'REFUND SHOES'],
], 'the balance at the end is not the amount; balances and totals are skipped');
r = readStatement('02/11/2026 Tesco £23.18\n15/11/2026 Salary £2,100.00\n20/11/2026 Rent £900.00', { today: '2026-11-18' });
assert.strictEqual(r.signs, 'guessed');
assert.deepStrictEqual(r.rows.map((x) => [x.posted_on, x.amount_cents]), [['2026-11-02', -2318], ['2026-11-15', 210000], ['2026-11-20', -90000]], 'day first; a salary reads as money in');
r = readStatement('2026-11-02 Gym 29.00\nNov 30 2026 Interest paid 1.12', { today: '2026-11-18' });
assert.deepStrictEqual(r.rows.map((x) => x.amount_cents), [-2900, 112]);
assert.match(readStatement('Nothing here\nat all', {}).problem, /No lines with a date and an amount/);

(async () => {
    const { createTestDb } = require('openvibe-sdk/testing');
    const { createVault } = require('../server/crypto');
    const { createStore } = require('../server/store');
    const { createApp } = require('../server/app');
    const { db, close } = await createTestDb({ migrations: path.join(__dirname, '..', 'migrations'), store: process.env.FINANCE_TEST_STORE || 'pglite', service: 'finance' });
    const ADA = 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAW';
    const BO = 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAX';
    const vault = createVault(crypto.randomBytes(32).toString('base64'));
    const store = createStore({ db, vault });
    const auth = { router: (express) => express.Router(), optionalAuth: () => (req, _res, next) => { const u = req.get('x-test-user'); if (u) req.user = { subject_id: u }; next(); } };
    const server = createApp({ db, vault, auth, now: () => new Date('2026-11-18T12:00:00Z') }).listen(0, '127.0.0.1');
    await new Promise((x) => server.once('listening', x));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, form, { as = ADA, site = 'same-origin' } = {}) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'sec-fetch-site': site, 'x-test-user': as, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() })
        .then(async (x) => ({ status: x.status, location: x.headers.get('location'), text: await x.text() }));
    try {
        const card = await store.addAccount(ADA, { name: 'Card', kind: 'credit' });
        const b64 = `data:application/pdf;base64,${pdf(CARD, { deflate: true }).toString('base64')}`;
        let res = await post(`/accounts/${card.id}/statement`, { pdf: b64, name: 'nov.pdf' });
        assert.strictEqual(res.status, 200, res.text.slice(0, 300));
        assert.match(res.text, /Check the statement/);
        assert.match(res.text, /nov\.pdf: 5 transactions found, \$3,140\.00 in and \$43\.92 out/);
        assert.strictEqual((res.text.match(/name="take" value="\d+" checked/g) || []).length, 5);
        assert.doesNotMatch(res.text, /name="signs" value="out"/, 'marked signs need no choice');
        assert.strictEqual(Number(await db.value('SELECT count(*) FROM finance_transactions WHERE owner = $1', [ADA])), 0, 'nothing is saved before Import');
        const rows = /name="rows" value="([^"]*)"/.exec(res.text)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

        const form = new URLSearchParams({ rows, signs: 'asread' });
        for (const i of [0, 2, 3]) form.append('take', String(i));
        res = await fetch(`${base}/accounts/${card.id}/statement/import`, { method: 'POST', redirect: 'manual', headers: { 'sec-fetch-site': 'same-origin', 'x-test-user': ADA, 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() })
            .then(async (x) => ({ status: x.status, location: x.headers.get('location') }));
        assert.strictEqual(res.status, 303);
        assert.match(res.location, /\?m=2026-11&imported=3,0$/, 'only the ticked ones');
        const saved = await store.transactions(ADA, card.id);
        assert.deepStrictEqual(saved.map((t) => t.payee).sort(), ['COFFEE SHOP', 'CORNER GROCER #44', 'STREAMFLIX']);
        res = await fetch(`${base}/accounts/${card.id}/statement/import`, { method: 'POST', redirect: 'manual', headers: { 'sec-fetch-site': 'same-origin', 'x-test-user': ADA, 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() })
            .then(async (x) => ({ location: x.headers.get('location') }));
        assert.match(res.location, /imported=0,3$/, 'the same statement twice adds nothing');

        // All positive: the person chooses how to read them.
        const plain = `data:application/pdf;base64,${pdf(['11/04/2026 Gym 29.00', '11/06/2026 Books 18.99']).toString('base64')}`;
        res = await post(`/accounts/${card.id}/statement`, { pdf: plain });
        assert.match(res.text, /does not mark money in and out/);
        const plainRows = /name="rows" value="([^"]*)"/.exec(res.text)[1].replace(/&quot;/g, '"');
        const f2 = new URLSearchParams({ rows: plainRows, signs: 'in' }); f2.append('take', '0'); f2.append('take', '1');
        await fetch(`${base}/accounts/${card.id}/statement/import`, { method: 'POST', redirect: 'manual', headers: { 'sec-fetch-site': 'same-origin', 'x-test-user': ADA, 'content-type': 'application/x-www-form-urlencoded' }, body: f2.toString() });
        assert.ok((await store.transactions(ADA, card.id)).filter((t) => ['Gym', 'Books'].includes(t.payee)).every((t) => t.amount_cents > 0), '"all money in" turns them');

        res = await post(`/accounts/${card.id}/statement`, { pdf: Buffer.from('Date,Amount').toString('base64') });
        assert.strictEqual(res.status, 422);
        assert.match(res.text, /could not be read: this is not a PDF/);
        res = await post(`/accounts/${card.id}/statement`, { pdf: pdf(['Hello there']).toString('base64') });
        assert.match(res.text, /No lines with a date and an amount/);
        res = await post(`/accounts/${card.id}/statement`, { pdf: b64 }, { as: BO });
        assert.strictEqual(res.status, 404, 'never another person\'s account');
        res = await post(`/accounts/${card.id}/statement`, { pdf: b64 }, { site: 'cross-site' });
        assert.strictEqual(res.status, 403);
        const page = await fetch(`${base}/accounts/${card.id}`, { headers: { 'x-test-user': ADA } }).then((x) => x.text());
        assert.match(page, /accept="\.csv,\.ofx,\.qfx,\.pdf/);
        assert.match(page, /data-fin-statement="\/accounts\//);
    } finally {
        server.close();
        await close();
    }
    console.log('statement: text PDFs read here, lines with a date and an amount, signs marked or chosen, checked before import, never twice');
})().catch((err) => { console.error(err); process.exit(1); });
