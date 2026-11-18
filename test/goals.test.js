'use strict';
/**
 * Goals and debt (migrations/0004, server/plan.js): payoff months and interest, a payment that never covers the
 * interest, paying more; a goal's amount a month to reach it by its date; goals tracking an account or a hand-kept
 * amount; a card's rate and payment from the page; only loans and cards take them; export and delete carry them.
 */
const assert = require('assert');
const path = require('node:path');
const crypto = require('node:crypto');
const { payoff, faster, perMonth } = require('../server/plan');

assert.deepStrictEqual(payoff({ owed_cents: 500000, apr_bps: 0, payment_cents: 15000 }), { months: 34, interest_cents: 0, never: false }, '$5,000 at 0%, $150 a month');
const card = payoff({ owed_cents: 500000, apr_bps: 2499, payment_cents: 15000 });
// The standard amortisation: n = -ln(1 - rP/A) / ln(1 + r) = 57.5 months, about $3,622 of interest.
assert.deepStrictEqual(card, { months: 58, interest_cents: 362226, never: false }, '$5,000 at 24.99%, $150 a month');
assert.strictEqual(payoff({ owed_cents: 500000, apr_bps: 2499, payment_cents: 10000 }).never, true, '$100 a month never covers $104 of interest');
assert.deepStrictEqual(payoff({ owed_cents: 0, apr_bps: 2499, payment_cents: 15000 }), { months: 0, interest_cents: 0, never: false });
const more = faster({ owed_cents: 500000, apr_bps: 2499, payment_cents: 15000 }, 5000);
assert.ok(more.months_sooner > 0 && more.interest_saved_cents > 0, 'paying more is sooner and cheaper');
assert.strictEqual(perMonth({ target_cents: 600000, have_cents: 0, target_on: '2027-11-01', today: '2026-11-18' }), 50000, '$6,000 in 12 months');
assert.strictEqual(perMonth({ target_cents: 600000, have_cents: 600000, target_on: '2027-11-01', today: '2026-11-18' }), 0, 'reached');
assert.strictEqual(perMonth({ target_cents: 600000, have_cents: 0, target_on: null, today: '2026-11-18' }), null, 'no date');
assert.strictEqual(perMonth({ target_cents: 600000, have_cents: 0, target_on: '2026-10-01', today: '2026-11-18' }), null, 'past');

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
    const server = createApp({ db, vault, auth, now: () => new Date('2026-11-18T12:00:00Z') }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, form, site = 'same-origin') => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'sec-fetch-site': site, 'x-test-user': ADA, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() })
        .then(async (r) => ({ status: r.status, location: r.headers.get('location'), text: await r.text() }));
    try {
        const savings = await store.addAccount(ADA, { name: 'Rainy day', kind: 'savings', opening_cents: 120000 });
        const visa = await store.addAccount(ADA, { name: 'Visa', kind: 'credit', opening_cents: -500000 });
        const checking = await store.addAccount(ADA, { name: 'Checking', kind: 'checking' });

        let r = await post('/goals', { name: 'Emergency fund', target: '6,000', target_on: '2027-11-01', account: savings.id });
        assert.strictEqual(r.status, 303, r.text);
        r = await post('/goals', { name: 'Trip to Lisbon', target: '1500', account: '' });
        let goals = await store.goals(ADA);
        assert.deepStrictEqual(goals.map((g) => [g.name, g.target_cents, g.have_cents]), [['Emergency fund', 600000, 120000], ['Trip to Lisbon', 150000, 0]]);
        r = await post(`/goals/${goals[1].id}/saved`, { saved: '400' });
        assert.strictEqual((await store.goals(ADA))[1].have_cents, 40000, 'a hand-kept amount');

        r = await post(`/accounts/${visa.id}/debt`, { apr: '24.99', payment: '150' });
        assert.strictEqual(r.status, 303, r.text);
        const acc = (await store.accounts(ADA)).find((a) => a.id === visa.id);
        assert.deepStrictEqual([acc.apr_bps, acc.payment_cents], [2499, 15000]);
        r = await post(`/accounts/${checking.id}/debt`, { apr: '5', payment: '10' });
        assert.strictEqual(r.status, 422, 'a checking account has no rate');
        assert.match(r.text, /Only a loan or a credit card/);
        r = await post('/goals', { name: 'x', target: '5' }, 'cross-site');
        assert.strictEqual(r.status, 403);

        const html = await fetch(`${base}/goals`, { headers: { 'x-test-user': ADA } }).then((x) => x.text());
        assert.match(html, /\$1,200\.00 of \$6,000\.00/);
        assert.match(html, /\$400\.00 a month reaches it by November 2027/, '$4,800 left over 12 months');
        assert.match(html, /Tracks <a href="\/accounts\//);
        assert.match(html, /\$5,000\.00 owed/);
        assert.match(html, /Paid off in <b>\d+ (months|years?)/);
        assert.match(html, /more a month: .* sooner and .* less interest/);
        assert.match(html, /Change the rate or payment/, 'set terms fold away');

        const ex = await store.exportAll(ADA);
        assert.strictEqual(ex.goals.length, 2);
        assert.strictEqual(ex.accounts.find((a) => a.id === visa.id).apr_bps, 2499);
        await post(`/goals/${goals[1].id}/delete`, {});
        assert.strictEqual((await store.goals(ADA)).length, 1);
        await store.removeAll(ADA);
        assert.strictEqual(Number(await db.value('SELECT count(*) FROM finance_goals WHERE owner = $1', [ADA])), 0);
    } finally {
        server.close();
        await close();
    }
    console.log('goals and debt: payoff and interest, never, paying more, a month to reach a goal, the page, export and delete');
})().catch((err) => { console.error(err); process.exit(1); });
