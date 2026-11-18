'use strict';
/**
 * Receipt photos (v0.12; server/receipt.js): the total (never a subtotal, tax or change), the day, the store; what was
 * not clear is said; a real picture read by Tesseract (where it is installed); the page: a photo in, the add form
 * filled in, nothing saved until Add it; refusals (not a photo, unreadable, another person's account, cross-site).
 */
const assert = require('assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readReceipt, ocr, ReceiptError } = require('../server/receipt');

const TODAY = '2026-11-18';
let r = readReceipt('CORNER GROCER\n123 Main St, Springfield\nTel 555-0100\n11/14/2026 18:42\nBananas 1.29\nMilk 2% 3.49\nSUBTOTAL 7.77\nTAX 0.62\nTOTAL 8.39\nVISA 8.39\nCHANGE 0.00\nThank you!', { today: TODAY });
assert.deepStrictEqual(r, { payee: 'CORNER GROCER', posted_on: '2026-11-14', amount_cents: -839, found: { payee: true, date: true, total: true } });
r = readReceipt('Welcome to\nBean There Coffee\nLatte 4.75\nMuffin 3.25\nNov 17, 2026', { today: TODAY });
assert.deepStrictEqual([r.payee, r.posted_on, r.found.total], ['Bean There Coffee', '2026-11-17', false], 'no total line: the largest amount, said to check');
r = readReceipt('THE HARDWARE PLACE\n18/11/2026\nGRAND TOTAL £ 1,204.50', { today: TODAY });
assert.deepStrictEqual([r.posted_on, r.amount_cents], ['2026-11-18', -120450], 'day first when the day is over 12');
r = readReceipt('Shop\n12/31/2027\nTOTAL 3.00', { today: TODAY });
assert.deepStrictEqual([r.posted_on, r.found.date], [TODAY, false], 'a day in the future is not the receipt\'s');
assert.deepStrictEqual(readReceipt('', { today: TODAY }), { payee: '', posted_on: TODAY, amount_cents: null, found: { payee: false, date: false, total: false } });

(async () => {
    if (fs.existsSync('/usr/bin/tesseract')) {
        const text = await ocr(fs.readFileSync(path.join(__dirname, 'fixtures', 'receipt.png')));
        assert.deepStrictEqual(readReceipt(text, { today: TODAY }), { payee: 'CORNER GROCER', posted_on: '2026-11-14', amount_cents: -839, found: { payee: true, date: true, total: true } }, 'a real picture, read');
        await assert.rejects(ocr(Buffer.from('not an image')), ReceiptError);
    } else {
        console.log('receipt: tesseract is not installed here, the real picture is skipped');
    }

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
    let seen = null;
    const readImage = async (bytes) => {
        seen = bytes;
        if (bytes.toString() === 'blurry') throw new ReceiptError('That photo could not be read. A JPEG or PNG of the whole receipt works best.');
        return 'CORNER GROCER\n11/14/2026\nTOTAL 8.39';
    };
    const server = createApp({ db, vault, auth, readImage, now: () => new Date('2026-11-18T12:00:00Z') }).listen(0, '127.0.0.1');
    await new Promise((x) => server.once('listening', x));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, form, { as = ADA, site = 'same-origin' } = {}) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'sec-fetch-site': site, 'x-test-user': as, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() })
        .then(async (x) => ({ status: x.status, location: x.headers.get('location'), text: await x.text() }));
    const photo = (s) => `data:image/jpeg;base64,${Buffer.from(s).toString('base64')}`;
    try {
        const acc = await store.addAccount(ADA, { name: 'Checking' });
        const page = await fetch(`${base}/accounts/${acc.id}`, { headers: { 'x-test-user': ADA } }).then((x) => x.text());
        assert.match(page, /From a receipt photo/);
        assert.match(page, /action="\/accounts\/[^"]+\/receipt"/);

        let res = await post(`/accounts/${acc.id}/receipt`, { image: photo('jpeg bytes') });
        assert.strictEqual(res.status, 200, res.text.slice(0, 200));
        assert.strictEqual(seen.toString(), 'jpeg bytes', 'the photo reached the reader as bytes');
        assert.match(res.text, /Check the receipt/);
        assert.match(res.text, /name="posted_on" value="2026-11-14"/);
        assert.match(res.text, /name="amount"[^>]*value="8\.39"/);
        assert.match(res.text, /name="payee"[^>]*value="CORNER GROCER"/);
        assert.match(res.text, /action="\/accounts\/[^"]+\/transactions"/, 'the usual add form');
        assert.strictEqual(Number(await db.value('SELECT count(*) FROM finance_transactions')), 0, 'nothing is saved before Add it');

        res = await post(`/accounts/${acc.id}/receipt`, { image: photo('blurry') });
        assert.strictEqual(res.status, 422);
        assert.match(res.text, /could not be read/);
        res = await post(`/accounts/${acc.id}/receipt`, { image: 'data:text/html;base64,PGI+' });
        assert.match(res.text, /Choose a photo of the receipt/);
        res = await post(`/accounts/${acc.id}/receipt`, { image: photo('x') }, { as: BO });
        assert.strictEqual(res.status, 404, 'never another person\'s account');
        res = await post(`/accounts/${acc.id}/receipt`, { image: photo('x') }, { site: 'cross-site' });
        assert.strictEqual(res.status, 403);
    } finally {
        server.close();
        await close();
    }
    console.log('receipt: the total, the day and the store read; a real picture through Tesseract; checked before it is added');
})().catch((err) => { console.error(err); process.exit(1); });
