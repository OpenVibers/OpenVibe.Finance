'use strict';
/**
 * OFX and QFX downloads (server/ofx.js): OFX 1.x (SGML, open leaf tags) and 2.x (XML), bank and credit-card statements,
 * dates with times and zones, escaped names; FITIDs make the same download twice, and two downloads that overlap, add
 * each transaction once; the page's import takes OFX as it takes CSV.
 */
const assert = require('assert');
const path = require('node:path');
const crypto = require('node:crypto');
const { isOfx, readOfx, ofxDate } = require('../server/ofx');

const OFX1 = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20261118120000</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20261102120000.000[-5:EST]
<TRNAMT>-23.18
<FITID>2026110200001
<NAME>CORNER GROCER &amp; DELI
<MEMO>POS PURCHASE
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20261101
<TRNAMT>3120.00
<FITID>2026110100007
<NAME>ACME CORP PAYROLL
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20261302
<TRNAMT>-1.00
<FITID>bad-date
<NAME>NOWHERE
</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

const OFX2 = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="211" SECURITY="NONE"?>
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>USD</CURDEF><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261107</DTPOSTED><TRNAMT>-412.20</TRNAMT><FITID>CC-77</FITID><NAME>AIRLINE TICKETS</NAME></STMTTRN>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261107</DTPOSTED><TRNAMT>-412.20</TRNAMT><FITID>CC-78</FITID><NAME>AIRLINE TICKETS</NAME></STMTTRN>
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;

assert.ok(isOfx(OFX1) && isOfx(OFX2), 'both versions are OFX');
assert.ok(!isOfx('Date,Description,Amount\n2026-11-01,x,1\n'), 'a CSV is not');
assert.strictEqual(ofxDate('20261118120000.000[-5:EST]'), '2026-11-18');
assert.strictEqual(ofxDate('20261302'), null);

const one = readOfx(OFX1);
assert.strictEqual(one.currency, 'USD');
assert.deepStrictEqual(one.rows, [
    { posted_on: '2026-11-02', amount_cents: -2318, payee: 'CORNER GROCER & DELI', memo: 'POS PURCHASE', category: '', fitid: '2026110200001' },
    { posted_on: '2026-11-01', amount_cents: 312000, payee: 'ACME CORP PAYROLL', memo: '', category: '', fitid: '2026110100007' },
]);
assert.deepStrictEqual(one.skipped, [{ line: 3, why: 'no posted date' }]);
const two = readOfx(OFX2);
assert.deepStrictEqual(two.rows.map((r) => [r.posted_on, r.amount_cents, r.fitid]), [['2026-11-07', -41220, 'CC-77'], ['2026-11-07', -41220, 'CC-78']]);
assert.match(readOfx('<OFX></OFX>').problem, /No transactions/);

(async () => {
    const { createTestDb } = require('openvibe-sdk/testing');
    const { createVault } = require('../server/crypto');
    const { createStore } = require('../server/store');
    const { createApp } = require('../server/app');
    const { db, close } = await createTestDb({ migrations: path.join(__dirname, '..', 'migrations'), store: process.env.FINANCE_TEST_STORE || 'pglite', service: 'finance' });
    const ADA = 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAW';
    const vault = createVault(crypto.randomBytes(32).toString('base64'));
    const store = createStore({ db, vault });
    const auth = { router: (express) => express.Router(), optionalAuth: () => (req, _res, next) => { const u = req.get('x-test-user'); if (u) req.user = { subject_id: u }; next(); } };
    const server = createApp({ db, vault, auth }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const importForm = (accId, text) => fetch(`${base}/accounts/${accId}/import`, { method: 'POST', redirect: 'manual', headers: { 'sec-fetch-site': 'same-origin', 'x-test-user': ADA, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csv: text }).toString() })
        .then(async (r) => ({ status: r.status, location: r.headers.get('location'), text: await r.text() }));
    try {
        const checking = await store.addAccount(ADA, { name: 'Checking' });
        let r = await importForm(checking.id, OFX1);
        assert.strictEqual(r.status, 303, r.text);
        assert.match(r.location, /imported=2,0$/);
        r = await importForm(checking.id, OFX1);
        assert.match(r.location, /imported=0,2$/, 'the same download twice adds nothing');
        // A later download that overlaps: one transaction already here, one new.
        const later = OFX1.replace(/<STMTTRN>\s*<TRNTYPE>CREDIT[\s\S]*?<\/STMTTRN>/, '<STMTTRN>\n<TRNTYPE>DEBIT\n<DTPOSTED>20261105\n<TRNAMT>-9.99\n<FITID>2026110500002\n<NAME>STREAMFLIX\n</STMTTRN>');
        r = await importForm(checking.id, later);
        assert.match(r.location, /imported=1,1$/);
        const card = await store.addAccount(ADA, { name: 'Card', kind: 'credit' });
        r = await importForm(card.id, OFX2);
        assert.match(r.location, /imported=2,0$/, 'two equal charges with their own FITIDs are two');
        const all = await store.transactions(ADA, checking.id);
        assert.deepStrictEqual(all.map((t) => t.payee).sort(), ['ACME CORP PAYROLL', 'CORNER GROCER & DELI', 'STREAMFLIX']);
        const api = await fetch(`${base}/api/v1/accounts/${card.id}/import`, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin', 'x-test-user': ADA, 'content-type': 'application/x-ofx' }, body: OFX2 }).then((x) => x.json());
        assert.deepStrictEqual([api.added, api.skipped], [0, 2], 'the API takes OFX too');
        const page = await fetch(`${base}/accounts/${checking.id}?m=2026-11`, { headers: { 'x-test-user': ADA } }).then((x) => x.text());
        assert.match(page, /CSV, OFX or QFX/);
        assert.match(page, /accept="\.csv,\.ofx,\.qfx/);
    } finally {
        server.close();
        await close();
    }
    console.log('ofx: 1.x and 2.x, bank and card, FITIDs exact across downloads, the page and the API');
})().catch((err) => { console.error(err); process.exit(1); });
