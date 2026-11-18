'use strict';
/**
 * Finance end to end on a migrated PostgreSQL (PGlite, or the containers with FINANCE_TEST_STORE=pg): two people,
 * accounts, typed and imported transactions, the same file twice, categories, the month, the API, export, deletion,
 * and nobody reading another's rows. A stand-in signs people in with an x-test-user header.
 */
const assert = require('assert');
const path = require('node:path');
const crypto = require('node:crypto');
const { createTestDb } = require('openvibe-sdk/testing');
const { createVault } = require('../server/crypto');
const { createApp } = require('../server/app');

const ADA = 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAW';
const BO = 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAX';
const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    const { db, close } = await createTestDb({ migrations: path.join(__dirname, '..', 'migrations'), store: process.env.FINANCE_TEST_STORE || 'pglite', service: 'finance' });
    const auth = {
        router: (express) => express.Router(),
        optionalAuth: () => (req, _res, next) => { const u = req.get('x-test-user'); if (u) req.user = { subject_id: u }; next(); },
    };
    const app = createApp({ db, vault: createVault(crypto.randomBytes(32).toString('base64')), auth, now: () => new Date('2026-11-18T12:00:00Z') });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const go = async (p, { as = null, method = 'GET', form = null, json = null, text = null, headers = {} } = {}) => {
        const h = { ...headers };
        if (as) h['x-test-user'] = as;
        let body;
        if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
        if (json) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
        if (text != null) { h['content-type'] = 'text/csv'; body = text; }
        const r = await fetch(base + p, { method, headers: h, body, redirect: 'manual' });
        const t = await r.text();
        return { status: r.status, location: r.headers.get('location'), text: t, json: () => JSON.parse(t), headers: r.headers };
    };
    let failed = 0;
    const check = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.stack}`); } };

    try {
        let acc;
        await check('signed out: what it is and its promises, never anyone\'s data; a page that needs you signs you in', async () => {
            const home = await go('/');
            assert.strictEqual(home.status, 200);
            assert.match(home.text, /Your money, your rules, your data/);
            assert.match(home.text, /No money moves/);
            assert.strictEqual(home.headers.get('cache-control'), 'private, no-store');
            const month = await go('/month');
            assert.strictEqual(month.status, 303);
            assert.match(month.location, /^\/auth\/login\?next=/);
            assert.strictEqual((await go('/api/v1/accounts')).status, 401);
        });

        await check('an account from the home page; its page shows the balance', async () => {
            const r = await go('/accounts', { as: ADA, method: 'POST', headers: SAME, form: { name: 'Everyday checking', kind: 'checking', currency: 'usd', opening: '1,000.00' } });
            assert.strictEqual(r.status, 303, r.text);
            acc = /^\/accounts\/(acc_[A-Za-z0-9_-]+)\?added=1$/.exec(r.location)[1];
            const page = await go(`/accounts/${acc}`, { as: ADA });
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /Everyday checking/);
            assert.match(page.text, /\$1,000\.00/);
        });

        await check('a typed transaction: money out by default, its payee sealed in the database', async () => {
            const r = await go(`/accounts/${acc}/transactions`, { as: ADA, method: 'POST', headers: SAME, form: { posted_on: '2026-11-03', amount: '42.50', direction: 'out', payee: 'Corner Grocer', category: 'Groceries' } });
            assert.strictEqual(r.status, 303, r.text);
            const row = await db.maybe('SELECT payee_enc, amount_cents, category, category_from FROM finance_transactions WHERE account_id = $1', [acc]);
            assert.strictEqual(Number(row.amount_cents), -4250);
            assert.ok(row.payee_enc.startsWith('v1.') && !row.payee_enc.includes('Corner'), 'stored sealed');
            assert.deepStrictEqual([row.category, row.category_from], ['Groceries', 'you']);
            const page = await go(`/accounts/${acc}?m=2026-11`, { as: ADA });
            assert.match(page.text, /Corner Grocer/);
            assert.match(page.text, /\$957\.50/, 'the balance moved');
        });

        await check('a CSV import adds the new rows; the same file again adds nothing; two equal rows in one file stay two', async () => {
            const csv = 'Date,Description,Amount\n2026-11-04,Coffee Bar,-4.50\n2026-11-04,Coffee Bar,-4.50\n2026-11-01,Paycheck,2500.00\n2026-10-28,Electric Co,-80.00\n';
            let r = await go(`/accounts/${acc}/import`, { as: ADA, method: 'POST', headers: SAME, form: { csv } });
            assert.strictEqual(r.status, 303, r.text);
            assert.match(r.location, /imported=4,0$/);
            r = await go(`/accounts/${acc}/import`, { as: ADA, method: 'POST', headers: SAME, form: { csv } });
            assert.match(r.location, /imported=0,4$/);
            const page = await go(r.location, { as: ADA });
            assert.match(page.text, /Imported 0 new transactions; 4 already here/);
            assert.strictEqual(Number(await db.value('SELECT count(*) FROM finance_transactions WHERE account_id = $1', [acc])), 5);
            const bad = await go(`/accounts/${acc}/import`, { as: ADA, method: 'POST', headers: SAME, form: { csv: 'Description,Amount\nx,1\n' } });
            assert.strictEqual(bad.status, 422);
            assert.match(bad.text, /No date column/);
        });

        await check('a category is corrected as a new revision; the month adds up by category, transfers left out', async () => {
            const txns = (await go(`/api/v1/accounts/${acc}/transactions?m=2026-11`, { as: ADA })).json().transactions;
            const coffee = txns.find((t) => t.payee === 'Coffee Bar');
            const r = await go(`/transactions/${coffee.id}/category`, { as: ADA, method: 'POST', headers: SAME, form: { category: 'Eating out' } });
            assert.strictEqual(r.status, 303);
            const row = await db.maybe('SELECT category, category_from, revision FROM finance_transactions WHERE id = $1', [coffee.id]);
            assert.deepStrictEqual([row.category, row.category_from, row.revision], ['Eating out', 'you', 2]);
            const m = (await go('/api/v1/months/2026-11', { as: ADA })).json();
            assert.strictEqual(m.income_cents, 250000);
            assert.strictEqual(m.spent_cents, 4250 + 450 + 450);
            const page = await go('/month?m=2026-11', { as: ADA });
            assert.match(page.text, /November 2026/);
            assert.match(page.text, /Groceries/);
        });

        await check('nobody reads or writes another person\'s rows', async () => {
            assert.strictEqual((await go(`/accounts/${acc}`, { as: BO })).status, 404);
            assert.strictEqual((await go(`/api/v1/accounts/${acc}/transactions`, { as: BO })).status, 404);
            const sneak = await go(`/accounts/${acc}/transactions`, { as: BO, method: 'POST', headers: SAME, form: { posted_on: '2026-11-05', amount: '1', payee: 'x' } });
            assert.strictEqual(sneak.status, 404);
            assert.deepStrictEqual((await go('/api/v1/accounts', { as: BO })).json().accounts, []);
            assert.strictEqual((await go('/api/v1/months/2026-11', { as: BO })).json().spent_cents, 0);
        });

        await check('a cross-site form post is refused; the API takes a CSV body and JSON', async () => {
            const cross = await go('/accounts', { as: ADA, method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, form: { name: 'x' } });
            assert.strictEqual(cross.status, 403);
            const apiCross = await go('/api/v1/accounts', { as: ADA, method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, json: { name: 'x' } });
            assert.strictEqual(apiCross.status, 403);
            const made = await go('/api/v1/accounts', { as: ADA, method: 'POST', headers: SAME, json: { name: 'Card', kind: 'credit' } });
            assert.strictEqual(made.status, 201, made.text);
            const imp = await go(`/api/v1/accounts/${made.json().id}/import`, { as: ADA, method: 'POST', headers: SAME, text: 'Date,Payee,Amount\n2026-11-10,Bookshop,-15.00\nsoon,x,1\n' });
            assert.strictEqual(imp.status, 201, imp.text);
            assert.strictEqual(imp.json().added, 1);
            assert.strictEqual(imp.json().unreadable.length, 1);
        });

        await check('export is everything, readable; delete is everything, after a yes', async () => {
            const ex = await go('/data/export', { as: ADA });
            assert.match(ex.headers.get('content-disposition'), /attachment; filename="openvibe-finance-2026-11\.json"/);
            const data = ex.json();
            assert.strictEqual(data.accounts.length, 2);
            assert.ok(data.transactions.some((t) => t.payee === 'Corner Grocer'), 'opened for its owner');
            const no = await go('/data/delete', { as: ADA, method: 'POST', headers: SAME, form: {} });
            assert.strictEqual(no.status, 422);
            const yes = await go('/data/delete', { as: ADA, method: 'POST', headers: SAME, form: { sure: 'yes' } });
            assert.strictEqual(yes.status, 303);
            assert.strictEqual(Number(await db.value("SELECT count(*) FROM finance_transactions WHERE owner = $1", [ADA])), 0);
            assert.strictEqual(Number(await db.value("SELECT count(*) FROM finance_accounts WHERE owner = $1", [ADA])), 0);
        });
    } finally {
        server.close();
        await close();
    }
    if (failed) { console.log(`${failed} failed`); process.exit(1); }
    console.log('finance: accounts, imports, months, privacy, export and deletion');
})().catch((err) => { console.error(err); process.exit(1); });
