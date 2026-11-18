'use strict';
/**
 * Recurring payments (server/recurring.js): a subscription whose reference number changes each month, rent, a paycheck
 * every two weeks and a yearly fee are found with their cadence, usual amount and next date; groceries (amounts all
 * over the place), one-offs and two sightings are not; a subscription that stopped is overdue. Then /bills and the API
 * over a person's own data.
 */
const assert = require('assert');
const path = require('node:path');
const crypto = require('node:crypto');
const { findRecurring } = require('../server/recurring');

const tx = (posted_on, amount_cents, payee, category = 'Uncategorized') => ({ posted_on, amount_cents, payee, category });
const monthly = (payee, cents, day, months) => months.map((m) => tx(`2026-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`, cents, payee));
const days = (start, every, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${start}T00:00:00Z`) + i * every * 86400000).toISOString().slice(0, 10));

const rows = [
    ...[6, 7, 8, 9, 10, 11].map((m, i) => tx(`2026-${String(m).padStart(2, '0')}-05`, -1599, `STREAMFLIX ${881234 + i * 1111} CA`)),
    ...monthly('Lakeview Apartments', -145000, 1, [6, 7, 8, 9, 10, 11]),
    ...days('2026-08-07', 14, 8).map((d) => tx(d, 312000, 'Paycheck ACME Corp')),
    tx('2024-03-15', -9900, 'Warehouse Club Membership'), tx('2025-03-14', -9900, 'Warehouse Club Membership'), tx('2026-03-16', -10500, 'Warehouse Club Membership'),
    ...[-8642, -1210, -15433, -2299, -6400, -910].map((c, i) => tx(`2026-11-${String(i * 3 + 1).padStart(2, '0')}`, c, 'Corner Grocer')),
    tx('2026-10-12', -41220, 'Airline Tickets'),
    tx('2026-09-01', -999, 'Puzzle App'), tx('2026-10-01', -999, 'Puzzle App'),
    ...monthly('Old Gym Co', -2900, 20, [4, 5, 6, 7]),
];
const found = findRecurring(rows, { today: '2026-11-18' });
const by = (p) => found.find((r) => r.payee.toLowerCase().startsWith(p.toLowerCase()));

const sub = by('STREAMFLIX');
assert.ok(sub, 'a subscription whose reference number changes is one series');
assert.deepStrictEqual([sub.cadence, sub.typical_cents, sub.count, sub.next_on, sub.overdue], ['monthly', 1599, 6, '2026-12-05', false]);
const rent = by('Lakeview');
assert.deepStrictEqual([rent.cadence, rent.typical_cents, rent.monthly_cents], ['monthly', 145000, 145000]);
const pay = by('Paycheck');
assert.deepStrictEqual([pay.direction, pay.cadence, pay.typical_cents], ['in', 'every two weeks', 312000]);
assert.strictEqual(pay.monthly_cents, Math.round(312000 * 30.4 / 14));
const club = by('Warehouse');
assert.deepStrictEqual([club.cadence, club.typical_cents], ['yearly', 9900]);
assert.ok(!by('Corner Grocer'), 'groceries are not a bill');
assert.ok(!by('Airline'), 'a one-off is not');
assert.ok(!by('Puzzle'), 'two sightings are not enough');
const gym = by('Old Gym');
assert.ok(gym && gym.overdue, 'a subscription that stopped is overdue');
assert.ok(found.indexOf(sub) < found.indexOf(rent) === (sub.next_on < rent.next_on), 'soonest first');

(async () => {
    const { createTestDb } = require('openvibe-sdk/testing');
    const { createVault } = require('../server/crypto');
    const { createStore } = require('../server/store');
    const { createApp } = require('../server/app');
    const { db, close } = await createTestDb({ migrations: path.join(__dirname, '..', 'migrations'), store: process.env.FINANCE_TEST_STORE || 'pglite', service: 'finance' });
    const ADA = 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAW';
    const vault = createVault(crypto.randomBytes(32).toString('base64'));
    const store = createStore({ db, vault });
    const acc = await store.addAccount(ADA, { name: 'Checking' });
    // Recent rows only (store.recent reads the last 400 days from the database's today).
    const today = new Date().toISOString().slice(0, 10);
    const back = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    await store.importRows(ADA, acc.id, [tx(back(95), -1599, 'STREAMFLIX 881001'), tx(back(64), -1599, 'STREAMFLIX 881002'), tx(back(34), -1599, 'STREAMFLIX 881003'), tx(back(3), -1599, 'STREAMFLIX 881004')]);
    const auth = { router: (express) => express.Router(), optionalAuth: () => (req, _res, next) => { const u = req.get('x-test-user'); if (u) req.user = { subject_id: u }; next(); } };
    const server = createApp({ db, vault, auth }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const page = await fetch(`${base}/bills`, { headers: { 'x-test-user': ADA } }).then((r) => r.text());
        assert.match(page, /About \$15\.99 a month/);
        assert.match(page, /STREAMFLIX 881004/);
        assert.match(page, /Every month/);
        const api = await fetch(`${base}/api/v1/recurring`, { headers: { 'x-test-user': ADA } }).then((r) => r.json());
        assert.strictEqual(api.recurring.length, 1);
        assert.strictEqual(api.recurring[0].key, undefined, 'the internal key stays inside');
        const other = await fetch(`${base}/api/v1/recurring`, { headers: { 'x-test-user': 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAX' } }).then((r) => r.json());
        assert.deepStrictEqual(other.recurring, [], 'nobody sees another person\'s');
        assert.ok(today, 'today');
    } finally {
        server.close();
        await close();
    }
    console.log('recurring: subscriptions, rent, paychecks and yearly fees found; groceries and one-offs not; a stopped one overdue');
})().catch((err) => { console.error(err); process.exit(1); });
