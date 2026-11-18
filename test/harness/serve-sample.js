'use strict';
/**
 * A local look at Finance's pages (not a test): the real app on PGlite, a stand-in sign-in as one person, and a month
 * of sample data.   node test/harness/serve-sample.js [port]   → prints the port, serves until killed.
 */
const path = require('node:path');
const crypto = require('node:crypto');
const { createTestDb } = require('openvibe-sdk/testing');
const { createVault } = require('../../server/crypto');
const { createApp } = require('../../server/app');
const { createStore } = require('../../server/store');
const { readCsv } = require('../../server/csv');

const ADA = 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAW';
(async () => {
    const { db } = await createTestDb({ migrations: path.join(__dirname, '..', '..', 'migrations') });
    const vault = createVault(crypto.randomBytes(32).toString('base64'));
    const store = createStore({ db, vault });
    const checking = await store.addAccount(ADA, { name: 'Everyday checking', kind: 'checking', opening_cents: 184250 });
    await store.addAccount(ADA, { name: 'Rainy day', kind: 'savings', opening_cents: 520000 });
    const card = await store.addAccount(ADA, { name: 'Travel card', kind: 'credit', opening_cents: -32075 });
    const csv = `Date,Description,Amount,Category
2026-11-01,Paycheck ACME Corp,3120.00,Income
2026-11-01,Lakeview Apartments,-1450.00,Housing
2026-11-02,Corner Grocer,-86.42,Groceries
2026-11-03,City Power & Light,-71.30,Utilities
2026-11-04,Bean There Coffee,-4.75,Eating out
2026-11-05,StreamFlix,-15.99,Subscriptions
2026-11-06,Metro Transit,-40.00,Transport
2026-11-08,Corner Grocer,-54.10,Groceries
2026-11-09,Pharmacy Plus,-23.80,Health
2026-11-11,Thai Garden,-38.60,Eating out
2026-11-12,Transfer to savings,-300.00,Transfers
2026-11-14,Bookshop on Main,-18.99,
2026-11-15,Paycheck ACME Corp,3120.00,Income
2026-11-16,Gym Monthly,-29.00,Subscriptions
`;
    await store.importRows(ADA, checking.id, readCsv(csv).rows);
    await store.importRows(ADA, card.id, readCsv('Date,Payee,Amount\n2026-11-07,Airline Tickets,-412.20\n2026-11-10,Hotel Downtown,-268.00\n').rows);
    await store.setBudget(ADA, 'Eating out', 4000);
    await store.setBudget(ADA, 'Groceries', 40000);
    await store.setBudget(ADA, 'Health', 5000);
    const rainy = (await store.accounts(ADA)).find((x) => x.name === 'Rainy day');
    await store.addGoal(ADA, { name: 'Emergency fund', target_cents: 1000000, target_on: '2027-11-01', account_id: rainy.id });
    await store.addGoal(ADA, { name: 'Trip to Lisbon', target_cents: 150000, saved_cents: 40000 });
    await store.setDebt(ADA, card.id, { apr_bps: 2499, payment_cents: 15000 });
    const auth = { router: (express) => express.Router(), optionalAuth: () => (req, _res, next) => { if (!req.get('x-guest')) req.user = { subject_id: ADA }; next(); } };
    const app = createApp({ db, vault, auth, baseUrl: 'http://127.0.0.1', now: () => new Date('2026-11-18T12:00:00Z') });
    const server = app.listen(Number(process.argv[2] || 0), '127.0.0.1', () => console.log(`port ${server.address().port} account ${checking.id}`));
})().catch((e) => { console.error(e); process.exit(1); });
