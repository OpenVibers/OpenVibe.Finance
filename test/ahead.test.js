'use strict';
/**
 * Net worth and what if (server/ahead.js, /ahead, /api/v1/net-worth, /api/v1/what-if): net worth at each month's end
 * (moves before the window counted, a negative balance owed); the average month over the months that had any; a
 * one-off cost that fits, one that does not yet (and the month it would), a monthly change from a month, a baseline
 * that runs out on its own; the page's verdicts, the goals line, bad input shown on the page, the API, another person.
 */
const assert = require('assert');
const path = require('node:path');
const crypto = require('node:crypto');
const { history, averageMonth, whatIf } = require('../server/ahead');

const months12 = ['2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06', '2027-07', '2027-08', '2027-09', '2027-10', '2027-11'];

assert.deepStrictEqual(history({
    accounts: [{ id: 'a', opening_cents: 100000 }, { id: 'b', opening_cents: 0 }],
    moves: [{ account_id: 'a', month: '2026-01', cents: 7 }, { account_id: 'a', month: '2026-09', cents: 50000 }, { account_id: 'b', month: '2026-10', cents: -30000 }, { account_id: 'a', month: '2026-11', cents: -20000 }],
    months: ['2026-09', '2026-10', '2026-11'],
}), [
    { month: '2026-09', assets_cents: 150007, owed_cents: 0, net_cents: 150007 },
    { month: '2026-10', assets_cents: 150007, owed_cents: 30000, net_cents: 120007 },
    { month: '2026-11', assets_cents: 130007, owed_cents: 30000, net_cents: 100007 },
]);
assert.deepStrictEqual(averageMonth([
    { month: '2026-08', income_cents: 0, spent_cents: 0 }, { month: '2026-09', income_cents: 300000, spent_cents: 200000 }, { month: '2026-10', income_cents: 310000, spent_cents: 220000 },
]), { income_cents: 305000, spending_cents: 210000, months: ['2026-09', '2026-10'] }, 'an empty month is not an average month');

const base = { start_cents: 100000, income_cents: 300000, spending_cents: 250000, months: months12 };
let p = whatIf(base);
assert.strictEqual(p.now[11].cents, 700000);
assert.strictEqual(p.below_zero_on, null);
p = whatIf({ ...base, cost_cents: 200000 });
assert.strictEqual(p.with[0].cents, -50000);
assert.strictEqual(p.below_zero_on, '2026-12');
assert.strictEqual(p.afford_by, '2027-01', 'two months of $500 left over pay a $2,000 cost from $1,000');
p = whatIf({ ...base, cost_cents: 100000, cost_on: '2027-03' });
assert.deepStrictEqual([p.with[2].cents, p.with[3].cents, p.below_zero_on], [250000, 200000, null]);
p = whatIf({ ...base, change_cents: -60000, change_from: '2027-02' });
assert.deepStrictEqual([p.with[1].cents, p.with[2].cents, p.with[11].cents, p.left_with_cents], [200000, 190000, 100000, -10000], 'rent up $600 from February');
p = whatIf({ start_cents: 120000, income_cents: 100000, spending_cents: 150000, months: months12 });
assert.strictEqual(p.now_below_zero_on, '2027-02', 'more going out than coming in runs out on its own');

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
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = (q = '', as = ADA) => fetch(`${base}/ahead${q}`, { redirect: 'manual', headers: as ? { 'x-test-user': as } : {} }).then(async (r) => ({ status: r.status, text: await r.text() }));
    const api = (p, as = ADA) => fetch(`${base}/api/v1${p}`, { headers: { 'x-test-user': as } }).then(async (r) => ({ status: r.status, body: await r.json() }));
    try {
        const checking = await store.addAccount(ADA, { name: 'Checking', kind: 'checking', opening_cents: 100000 });
        const savings = await store.addAccount(ADA, { name: 'Savings', kind: 'savings', opening_cents: 500000 });
        const card = await store.addAccount(ADA, { name: 'Card', kind: 'credit' });
        const rows = [];
        for (const m of ['2026-08', '2026-09', '2026-10']) {
            rows.push({ posted_on: `${m}-01`, amount_cents: 300000, payee: 'Paycheck', category: 'Income' });
            rows.push({ posted_on: `${m}-03`, amount_cents: -150000, payee: 'Rent', category: 'Housing' });
            rows.push({ posted_on: `${m}-10`, amount_cents: -50000, payee: 'Grocer', category: 'Groceries' });
        }
        rows.push({ posted_on: '2026-10-20', amount_cents: -50000, payee: 'To savings', category: 'Transfers' });
        await store.importRows(ADA, checking.id, rows);
        await store.importRows(ADA, savings.id, [{ posted_on: '2026-10-20', amount_cents: 50000, payee: 'From checking', category: 'Transfers' }]);
        await store.importRows(ADA, card.id, [{ posted_on: '2026-10-12', amount_cents: -30000, payee: 'Shoes', category: 'Shopping' }]);

        let r = await page();
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.match(r.text, /<p class="fin-big">\$8,700\.00<\/p>/, '$3,500 checking + $5,500 savings − $300 owed');
        assert.match(r.text, /\+\$1,700\.00<\/span> since August 2026/, 'from the first month with data, not a year of openings');
        assert.match(r.text, /\$3,000\.00 in, \$2,100\.00 out, <b>\$900\.00<\/b> left over\. \$8,700\.00 to spend now/, 'transfers left out of the average');
        assert.match(r.text, /about <b>\$19,500\.00<\/b> to spend in November 2027/);
        assert.match(r.text, /<svg class="fin-chart"/);

        r = await page('?cost=12%2C000&cost_on=2026-12');
        assert.match(r.text, /Not yet: it takes you below zero in December 2026/);
        assert.match(r.text, /could pay it in <b>March 2027<\/b>/);
        r = await page('?cost=5000');
        assert.match(r.text, /Yes\. The lowest it gets is <b>\$4,600\.00<\/b>, in December 2026/);
        assert.match(r.text, /As things are/);

        await store.addGoal(ADA, { name: 'House', target_cents: 1000000, target_on: '2027-11-01' });
        r = await page('?change=1000&dir=out&from=2027-02');
        assert.match(r.text, /Left over each month: \$900\.00 now, <b>-\$100\.00<\/b> with the change/);
        assert.match(r.text, /Your goals with dates need \$833\.34 a month: this leaves less than that/);
        assert.match(r.text, /name="change"[^>]*value="1000"/, 'the question stays in the form');
        assert.match(r.text, /name="from" value="2027-02" checked/, 'and its month chip');
        assert.doesNotMatch(r.text, /type="month"/, 'no browser month box');

        r = await page('?cost=lots');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /role="alert">The cost is not a number\./);
        r = await page('?cost=10&cost_on=2030-01');
        assert.match(r.text, /within the next twelve months/);

        let a = await api('/what-if?cost=5000');
        assert.strictEqual(a.status, 200);
        assert.deepStrictEqual([a.body.plan.lowest.cents, a.body.spendable_cents, a.body.average.income_cents], [460000, 870000, 300000]);
        a = await api('/what-if?cost=abc');
        assert.strictEqual(a.status, 422);
        assert.deepStrictEqual(a.body, { error: 'The cost is not a number.', code: 'finance.ahead.ask' }, 'an API error is JSON, not a page');
        a = await api('/net-worth');
        assert.deepStrictEqual(a.body.net_worth.map((x) => [x.month, x.net_cents]), [['2026-08', 700000], ['2026-09', 800000], ['2026-10', 870000], ['2026-11', 870000]]);

        r = await page('', BO);
        assert.match(r.text, /Add an account on <a href="\/">Your money<\/a>/, 'another person sees none of it');
        assert.doesNotMatch(r.text, /8,700/);
        r = await page('', null);
        assert.ok([302, 303].includes(r.status), `signed out goes to sign in: ${r.status}`);
    } finally {
        server.close();
        await close();
    }
    console.log('ahead: net worth over time, the average month, yes, not yet and when, a monthly change, goals, bad input, the API, another person');
})().catch((err) => { console.error(err); process.exit(1); });
