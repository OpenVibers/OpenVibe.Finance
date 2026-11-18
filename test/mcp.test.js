'use strict';
/**
 * Finance's MCP server (server/mcp.js, POST /mcp): seven read-only tools; anyone may list them; a call reads the person
 * from a Bearer token only (a delegated person token naming finance included), never from a cookie or the pages'
 * sign-in; the pages and the API refuse a delegated person; each tool answers the person's own data only; arguments are
 * checked against the schema; both MCP eras (handshake and 2026-07-28 stateless) on one endpoint.
 */
const assert = require('assert');
const path = require('node:path');
const crypto = require('node:crypto');
const mcp = require('openvibe-sdk/mcp');
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
    // The pages' sign-in: x-test-user (x-test-delegated makes that person a delegated one, which the pages must refuse).
    const auth = { router: (express) => express.Router(), optionalAuth: () => (req, _res, next) => {
        const u = req.get('x-test-user');
        if (u) req.user = req.get('x-test-delegated') ? { subject_id: u, typ: 'delegated', delegated: { by: 'key_1', scope: 'read', services: ['finance'] } } : { subject_id: u };
        next();
    } };
    // /mcp's sign-in: "Bearer person:<subject>" or "Bearer delegated:<subject>"; anything else is nobody.
    const mcpAuth = { optionalAuth: () => (req, _res, next) => {
        const m = /^Bearer (person|delegated):(\S+)$/.exec(String(req.get('authorization') || ''));
        if (m) req.user = m[1] === 'delegated' ? { subject_id: m[2], typ: 'delegated', delegated: { by: 'key_1', scope: 'read', services: ['finance'] } } : { subject_id: m[2] };
        next();
    } };
    const server = createApp({ db, vault, auth, mcpAuth, now: () => new Date('2026-11-18T12:00:00Z') }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    let n = 0;
    const rpc = async (method, params = {}, headers = {}) => {
        const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) });
        return { status: r.status, body: r.status === 202 ? null : await r.json() };
    };
    const call = async (name, args, as = `delegated:${ADA}`) => (await rpc('tools/call', { name, arguments: args }, as ? { authorization: `Bearer ${as}` } : {})).body.result;
    try {
        const checking = await store.addAccount(ADA, { name: 'Checking', kind: 'checking', opening_cents: 100000 });
        const card = await store.addAccount(ADA, { name: 'Visa', kind: 'credit', opening_cents: -500000 });
        await store.setDebt(ADA, card.id, { apr_bps: 2499, payment_cents: 15000 });
        const rows = [];
        for (const m of ['2026-08', '2026-09', '2026-10', '2026-11']) {
            rows.push({ posted_on: `${m}-01`, amount_cents: 300000, payee: 'Paycheck', category: 'Income' });
            rows.push({ posted_on: `${m}-03`, amount_cents: -150000, payee: 'Rent', category: 'Housing' });
            rows.push({ posted_on: `${m}-05`, amount_cents: -1599, payee: 'StreamFlix', category: 'Subscriptions' });
        }
        await store.importRows(ADA, checking.id, rows);
        await store.setBudget(ADA, 'Subscriptions', 1000);
        await store.addGoal(ADA, { name: 'Trip', target_cents: 120000, target_on: '2027-11-01' });
        const boAcc = await store.addAccount(BO, { name: 'Bo private', kind: 'checking', opening_cents: 999900 });

        // The handshake era, as Network's /mcp/all calls it.
        let r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
        assert.strictEqual(r.body.result.protocolVersion, '2025-06-18');
        assert.strictEqual(r.body.result.serverInfo.name, 'openvibe-finance');
        const note = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
        assert.strictEqual(note.status, 202, 'a notification is accepted with nothing to say');
        r = await rpc('tools/list');
        const names = r.body.result.tools.map((t) => t.name);
        assert.deepStrictEqual(names, ['accounts', 'month', 'transactions', 'recurring', 'goals', 'net_worth', 'what_if'], 'anyone may list them');
        assert.ok(r.body.result.tools.every((t) => t.annotations.readOnlyHint === true && t.annotations.destructiveHint === false), 'every tool is read only');

        // Nobody, or a cookie-style sign-in, is not a person here.
        assert.match((await call('accounts', {}, null)).content[0].text, /connect OpenVibe Finance/);
        r = await rpc('tools/call', { name: 'accounts', arguments: {} }, { 'x-test-user': ADA });
        assert.strictEqual(r.body.result.isError, true, 'the pages\' sign-in does not reach /mcp');

        let out = await call('accounts', {});
        assert.deepStrictEqual(out.structuredContent.accounts.map((a) => [a.name, a.balance_cents]), [['Checking', 100000 + 4 * (300000 - 150000 - 1599)], ['Visa', -500000]]);
        assert.ok(!JSON.stringify(out).includes('Bo private'), 'another person\'s accounts never');
        out = await call('accounts', {}, `person:${ADA}`);
        assert.strictEqual(out.isError, false, 'the person\'s own Bearer sign-in works too');

        out = await call('month', { month: '2026-10' });
        assert.deepStrictEqual(out.structuredContent.by_category.find((c) => c.category === 'Subscriptions'), { category: 'Subscriptions', in_cents: 0, out_cents: 1599, count: 1, budget_cents: 1000, left_cents: -599 });
        out = await call('transactions', { month: '2026-11', limit: 2 });
        assert.deepStrictEqual(out.structuredContent.transactions.map((t) => [t.posted_on, t.payee]), [['2026-11-05', 'StreamFlix'], ['2026-11-03', 'Rent']], 'payees opened for the person');
        out = await call('transactions', { account_id: boAcc.id });
        assert.match(out.content[0].text, /No such account of yours/);
        out = await call('recurring', {});
        assert.ok(out.structuredContent.recurring.some((x) => x.payee === 'StreamFlix' && x.cadence === 'monthly'));
        out = await call('goals', {});
        assert.deepStrictEqual(out.structuredContent.debts.map((d) => [d.name, d.owed_cents, d.payoff_months, d.interest_cents]), [['Visa', 500000, 58, 362226]]);
        assert.strictEqual(out.structuredContent.goals[0].name, 'Trip');
        out = await call('net_worth', {});
        assert.strictEqual(out.structuredContent.net_worth[0].month, '2026-08');
        out = await call('what_if', { cost_cents: 50000000 });
        assert.ok(out.structuredContent.plan.below_zero_on, 'a $500,000 cost does not fit');
        out = await call('what_if', { change_cents: 10000, direction: 'out', from: '2027-02' });
        assert.strictEqual(out.structuredContent.plan.left_with_cents, out.structuredContent.plan.left_now_cents - 10000);

        for (const [name, args, said] of [['month', { month: '2026-13' }, /"month" is not right/], ['accounts', { secret: 1 }, /accounts takes no "secret"/], ['transactions', { limit: 9999 }, /"limit" is a whole number from 1 to 500/], ['what_if', { cost_on: '2031-01', cost_cents: 5 }, /within the next twelve months/]]) {
            out = await call(name, args);
            assert.strictEqual(out.isError, true, name);
            assert.match(out.content[0].text, said);
        }
        r = await rpc('tools/call', { name: 'pay_bill', arguments: {} }, { authorization: `Bearer delegated:${ADA}` });
        assert.strictEqual(r.body.error.code, -32602, 'there is no tool that moves money');

        // The 2026-07-28 era: stateless, headers that agree with the body.
        const modern = async (method, params, auth) => {
            const { headers, body } = mcp.modernRequest({ id: ++n, method, params, clientInfo: { name: 't', version: '1' } });
            const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) });
            return { status: res.status, body: await res.json() };
        };
        r = await modern('server/discover', {});
        assert.ok(r.body.result.supportedVersions.includes('2026-07-28'));
        r = await modern('tools/list', {});
        assert.strictEqual(r.body.result.resultType, 'complete');
        assert.strictEqual(r.body.result.tools.length, 7);
        r = await modern('tools/call', { name: 'accounts', arguments: {} }, `Bearer delegated:${ADA}`);
        assert.strictEqual(r.body.result.resultType, 'complete');
        assert.strictEqual(r.body.result.structuredContent.accounts.length, 2);
        const lie = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' }, body: JSON.stringify(mcp.modernRequest({ id: 1, method: 'tools/call', params: { name: 'accounts' } }).body) });
        assert.strictEqual(lie.status, 400, 'headers that disagree with the body are refused');
        r = await modern('resources/list', {});
        assert.strictEqual(r.status, 404);

        // The pages and the API never take a delegated person.
        const api = await fetch(`${base}/api/v1/accounts`, { headers: { 'x-test-user': ADA, 'x-test-delegated': '1' } });
        assert.strictEqual(api.status, 401, 'the API refuses something acting for the person');
        const pageRes = await fetch(`${base}/data`, { redirect: 'manual', headers: { 'x-test-user': ADA, 'x-test-delegated': '1' } });
        assert.ok([302, 303].includes(pageRes.status), 'and so do the pages');
        assert.strictEqual((await fetch(`${base}/mcp`)).status, 405);
    } finally {
        server.close();
        await close();
    }
    console.log('mcp: seven read-only tools, Bearer only (delegated included), the person\'s own data, schemas checked, both eras; pages and API refuse delegated');
})().catch((err) => { console.error(err); process.exit(1); });
