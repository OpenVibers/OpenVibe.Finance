'use strict';
/**
 * Budgets (migrations/0003_budgets.sql): a monthly limit for a category of spending, set from the month page; the month
 * shows what is left or how much over, budgeted categories with nothing spent yet included; income, transfers and
 * Uncategorized take no budget; an empty amount removes one; another person sees none; export carries them and delete
 * removes them.
 */
const assert = require('assert');
const path = require('node:path');
const crypto = require('node:crypto');
const { createTestDb } = require('openvibe-sdk/testing');
const { createVault } = require('../server/crypto');
const { createStore } = require('../server/store');
const { createApp } = require('../server/app');

const ADA = 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAW';
const BO = 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAX';

(async () => {
    const { db, close } = await createTestDb({ migrations: path.join(__dirname, '..', 'migrations'), store: process.env.FINANCE_TEST_STORE || 'pglite', service: 'finance' });
    const vault = createVault(crypto.randomBytes(32).toString('base64'));
    const store = createStore({ db, vault });
    const auth = { router: (express) => express.Router(), optionalAuth: () => (req, _res, next) => { const u = req.get('x-test-user'); if (u) req.user = { subject_id: u }; next(); } };
    const server = createApp({ db, vault, auth, now: () => new Date('2026-11-18T12:00:00Z') }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, form, as = ADA) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'sec-fetch-site': 'same-origin', 'x-test-user': as, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() })
        .then(async (r) => ({ status: r.status, location: r.headers.get('location'), text: await r.text() }));
    const page = (p, as = ADA) => fetch(base + p, { headers: { 'x-test-user': as } }).then((r) => r.text());
    try {
        const acc = await store.addAccount(ADA, { name: 'Checking' });
        await store.importRows(ADA, acc.id, [
            { posted_on: '2026-11-02', amount_cents: -24000, payee: 'Thai Garden', category: 'Eating out' },
            { posted_on: '2026-11-09', amount_cents: -9000, payee: 'Pizza Place', category: 'Eating out' },
            { posted_on: '2026-11-03', amount_cents: -12000, payee: 'Corner Grocer', category: 'Groceries' },
        ]);

        let r = await post('/budgets', { category: 'Eating out', amount: '300', back: '2026-11' });
        assert.strictEqual(r.status, 303, r.text);
        assert.strictEqual(r.location, '/month?m=2026-11&budgeted=1');
        r = await post('/budgets', { category: 'Groceries', amount: '$400.00', back: '2026-11' });
        r = await post('/budgets', { category: 'Health', amount: '50', back: '2026-11' });
        assert.deepStrictEqual(await store.budgets(ADA), [
            { category: 'Eating out', monthly_cents: 30000 }, { category: 'Groceries', monthly_cents: 40000 }, { category: 'Health', monthly_cents: 5000 }]);

        let html = await page('/month?m=2026-11');
        assert.match(html, /\$30\.00 over/, 'Eating out: $330 of $300');
        assert.match(html, /\$280\.00 left/, 'Groceries: $120 of $400');
        assert.match(html, /\$50\.00 left/, 'Health: nothing spent yet, still shown');
        assert.match(html, /\$450\.00 of \$750\.00 spent/, '$330 + $120 + $0, the overspend counted');
        assert.match(html, /class="is-over"/);

        r = await post('/budgets', { category: 'Eating out', amount: '400', back: '2026-11' });
        assert.strictEqual((await store.budgets(ADA))[0].monthly_cents, 40000, 'the same category again replaces it');
        r = await post('/budgets', { category: 'Health', amount: '', back: '2026-11' });
        assert.strictEqual(r.location, '/month?m=2026-11&unbudgeted=1');
        assert.ok(!(await store.budgets(ADA)).some((b) => b.category === 'Health'), 'an empty amount removes it');

        for (const category of ['Income', 'Transfers', 'Uncategorized']) {
            r = await post('/budgets', { category, amount: '100' });
            assert.strictEqual(r.status, 422, category);
        }
        r = await post('/budgets', { category: 'Fees', amount: 'lots' });
        assert.strictEqual(r.status, 422);
        r = await fetch(`${base}/budgets`, { method: 'POST', redirect: 'manual', headers: { 'sec-fetch-site': 'cross-site', 'x-test-user': ADA, 'content-type': 'application/x-www-form-urlencoded' }, body: 'category=Fees&amount=5' });
        assert.strictEqual(r.status, 403);

        assert.deepStrictEqual((await fetch(`${base}/api/v1/budgets`, { headers: { 'x-test-user': BO } }).then((x) => x.json())).budgets, [], 'nobody sees another person\'s');
        const put = await fetch(`${base}/api/v1/budgets/${encodeURIComponent('Shopping')}`, { method: 'PUT', headers: { 'sec-fetch-site': 'same-origin', 'x-test-user': ADA, 'content-type': 'application/json' }, body: JSON.stringify({ monthly_cents: 10000 }) });
        assert.strictEqual(put.status, 200);
        assert.ok((await store.budgets(ADA)).some((b) => b.category === 'Shopping'));

        assert.strictEqual((await store.exportAll(ADA)).budgets.length, 3);
        await store.removeAll(ADA);
        assert.strictEqual(Number(await db.value('SELECT count(*) FROM finance_budgets WHERE owner = $1', [ADA])), 0);
    } finally {
        server.close();
        await close();
    }
    console.log('budgets: set, replaced and removed; left and over on the month; refused where they mean nothing; exported and deleted');
})().catch((err) => { console.error(err); process.exit(1); });
