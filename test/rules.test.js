'use strict';
/**
 * Category rules (migrations/0002_rules.sql): "Always" on a transaction's category makes a rule for its payee's words;
 * the rule categorises the past transactions nobody categorised and every later import, never one the person set;
 * reference numbers do not matter; the words are sealed; the same words again replace the category; removing a rule
 * leaves what it did; export carries the rules and delete removes them.
 */
const assert = require('assert');
const path = require('node:path');
const crypto = require('node:crypto');
const { createTestDb } = require('openvibe-sdk/testing');
const { createVault } = require('../server/crypto');
const { createApp } = require('../server/app');
const { createStore, matchable } = require('../server/store');

const ADA = 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAW';
const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    assert.strictEqual(matchable('AMAZON MKTPLACE PMTS 1234567 WA'), 'amazon mktplace pmts wa');
    assert.strictEqual(matchable('  Corner   Grocer #22 '), 'corner grocer 22');

    const { db, close } = await createTestDb({ migrations: path.join(__dirname, '..', 'migrations'), store: process.env.FINANCE_TEST_STORE || 'pglite', service: 'finance' });
    const vault = createVault(crypto.randomBytes(32).toString('base64'));
    const store = createStore({ db, vault });
    const auth = { router: (express) => express.Router(), optionalAuth: () => (req, _res, next) => { const u = req.get('x-test-user'); if (u) req.user = { subject_id: u }; next(); } };
    const server = createApp({ db, vault, auth, now: () => new Date('2026-11-18T12:00:00Z') }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (p, form) => {
        const r = await fetch(base + p, { method: 'POST', redirect: 'manual', headers: { ...SAME, 'x-test-user': ADA, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
        return { status: r.status, location: r.headers.get('location'), text: await r.text() };
    };
    let failed = 0;
    const check = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.stack}`); } };

    try {
        const acc = await store.addAccount(ADA, { name: 'Checking' });
        await store.importRows(ADA, acc.id, [
            { posted_on: '2026-11-01', amount_cents: -1299, payee: 'STREAMCO 88812345 CA' },
            { posted_on: '2026-10-01', amount_cents: -1299, payee: 'STREAMCO 77712345 CA' },
            { posted_on: '2026-11-02', amount_cents: -5000, payee: 'Corner Grocer' },
        ]);
        const list = await store.transactions(ADA, acc.id);
        const nov = list.find((t) => t.payee.startsWith('STREAMCO 888'));

        await check('Always on a category makes a rule; it categorises the past, whatever the reference number', async () => {
            const r = await post(`/transactions/${nov.id}/category`, { category: 'Subscriptions', always: 'yes' });
            assert.strictEqual(r.status, 303, r.text);
            assert.match(r.location, /ruled=1$/, 'one earlier transaction (October\'s) besides this one');
            const after = await store.transactions(ADA, acc.id);
            assert.deepStrictEqual(after.filter((t) => t.payee.startsWith('STREAMCO')).map((t) => [t.category, t.category_from]).sort(), [['Subscriptions', 'rule'], ['Subscriptions', 'you']]);
            assert.strictEqual(after.find((t) => t.payee === 'Corner Grocer').category, 'Uncategorized', 'another payee is left alone');
            const rules = await store.rules(ADA);
            assert.deepStrictEqual(rules.map((r) => [r.match, r.category]), [['streamco ca', 'Subscriptions']]);
            const row = await db.maybe('SELECT match_enc FROM finance_rules WHERE owner = $1', [ADA]);
            assert.ok(row.match_enc.startsWith('v1.') && !row.match_enc.includes('streamco'), 'the words are sealed');
        });

        await check('a later import falls under the rule; a category the file or the person gave stays', async () => {
            await store.importRows(ADA, acc.id, [
                { posted_on: '2026-12-01', amount_cents: -1299, payee: 'STREAMCO 99912345 CA' },
                { posted_on: '2026-12-02', amount_cents: -1299, payee: 'STREAMCO 99912345 CA', category: 'Entertainment' },
            ]);
            const dec = await store.transactions(ADA, acc.id, { month: '2026-12' });
            assert.deepStrictEqual(dec.map((t) => [t.category, t.category_from]).sort(), [['Entertainment', 'file'], ['Subscriptions', 'rule']]);
            const mine = await store.addTransaction(ADA, acc.id, { posted_on: '2026-12-03', amount_cents: -100, payee: 'STREAMCO gift', category: 'Gifts and giving' });
            await store.applyRules(ADA);
            assert.strictEqual((await store.transactions(ADA, acc.id, { month: '2026-12' })).find((t) => t.id === mine.id).category, 'Gifts and giving', 'yours stays yours');
        });

        await check('the same words again replace the category; the rules page lists them; remove leaves what they did', async () => {
            const again = await store.addRule(ADA, { match: 'STREAMCO  CA', category: 'Entertainment' });
            assert.strictEqual((await store.rules(ADA)).length, 1);
            assert.strictEqual((await store.rules(ADA))[0].category, 'Entertainment');
            assert.strictEqual(again.match, 'streamco ca');
            const page = await fetch(`${base}/rules`, { headers: { 'x-test-user': ADA } }).then((r) => r.text());
            assert.match(page, /streamco ca/);
            assert.match(page, /Entertainment/);
            const r = await post(`/rules/${again.id}/delete`, {});
            assert.strictEqual(r.status, 303);
            assert.deepStrictEqual(await store.rules(ADA), []);
            assert.strictEqual((await store.transactions(ADA, acc.id, { month: '2026-11' })).find((t) => t.id === nov.id).category, 'Subscriptions', 'what it did stays');
            await assert.rejects(store.addRule(ADA, { match: 'x', category: 'Fees' }), /few words/);
            await assert.rejects(store.addRule(ADA, { match: 'corner grocer', category: '' }), /which category/);
        });

        await check('export carries the rules; delete everything removes them', async () => {
            await store.addRule(ADA, { match: 'Corner Grocer', category: 'Groceries' });
            const ex = await store.exportAll(ADA);
            assert.deepStrictEqual(ex.rules, [{ match: 'corner grocer', category: 'Groceries' }]);
            await store.removeAll(ADA);
            assert.strictEqual(Number(await db.value('SELECT count(*) FROM finance_rules WHERE owner = $1', [ADA])), 0);
        });
    } finally {
        server.close();
        await close();
    }
    if (failed) { console.log(`${failed} failed`); process.exit(1); }
    console.log('rules: made from a category, the past and later imports, yours kept, sealed, exported and deleted');
})().catch((err) => { console.error(err); process.exit(1); });
