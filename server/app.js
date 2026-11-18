'use strict';
/**
 * OpenVibe.Finance (plan §L.2): the pages and the JSON API over one person's accounts and transactions.
 *
 *   createApp({ db, vault, auth, mcpAuth, baseUrl }) → an Express app
 *     auth: openvibe-sdk/sso's client (router, optionalAuth); tests pass a stand-in that sets req.user.
 *     mcpAuth: a second client that also takes a delegated person token naming finance, used on POST /mcp only
 *       (server/mcp.js); without it /mcp reads the person from a Bearer token of the ordinary client.
 *
 * Pages: / (signed out: what it is; signed in: your accounts and this month), /accounts/:id (?m=YYYY-MM), /month,
 * /data (download or delete everything). API (JSON, the same person, same rules): /api/v1/accounts,
 * /api/v1/accounts/:id/transactions, /api/v1/accounts/:id/import (text/csv), /api/v1/months/:m, /api/v1/export.
 * Every write is same-origin (a page form) or a Bearer call; nothing is cached; every answer says noindex.
 */
const express = require('express');
const path = require('node:path');
const { createStore, FinanceError } = require('./store');
const { readCsv, readAmount } = require('./csv');
const { isOfx, readOfx } = require('./ofx');
const ahead = require('./ahead');
const { perMonth } = require('./plan');
/** A bank's export, whichever it is: OFX or QFX by its header, else CSV. */
const readExport = (text) => (isOfx(text) ? readOfx(text) : readCsv(text));
const { findRecurring } = require('./recurring');
const v = require('./views');

function createApp({ db, vault, auth, mcpAuth = null, baseUrl = 'https://openvibe.finance', now = () => new Date() }) {
    const store = createStore({ db, vault });
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 'loopback');
    try {
        const release = require('openvibe-shared/release').createRelease({ service: 'finance', root: path.join(__dirname, '..') });
        require('openvibe-shared/metrics').instrument(app, { service: 'finance', release: release.release });
        app.get('/release.json', release.handler);
    } catch { /* metrics are optional in tests */ }
    app.use((req, res, next) => {
        res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex, nofollow' });
        next();
    });
    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'finance' }));
    app.get('/api/ready', async (_req, res) => {
        try { await db.value('SELECT 1'); res.json({ status: 'ok', service: 'finance' }); } catch { res.status(503).json({ status: 'unavailable' }); }
    });
    app.get('/robots.txt', (_req, res) => res.type('text').send('User-agent: *\nAllow: /$\nDisallow: /\n'));
    app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
    app.use('/shared', require('openvibe-shared/serve').handler());
    if (auth) app.use('/auth', auth.router(express));
    // POST /mcp (server/mcp.js), before the pages' sign-in: a Bearer token only (never a cookie), which may be a
    // delegated person token for this service (mcpAuth); the pages and the API below never take one.
    const finMcp = require('./mcp').createMcp({ store, aheadFor: (me, q) => aheadFor(me, q), now });
    const bearerOnly = (req, _res, next) => { if (!/^Bearer\s+\S/i.test(String(req.get('authorization') || ''))) { delete req.headers.cookie; req.user = undefined; } next(); };
    const mcpWho = mcpAuth || auth;
    app.post('/mcp', express.json({ limit: '5mb' }), bearerOnly, (req, res, next) => (mcpWho && /^Bearer\s/i.test(String(req.get('authorization') || '')) ? mcpWho.optionalAuth()(req, res, next) : next()),
        (req, res, next) => { res.set('Cache-Control', 'private, no-store'); Promise.resolve(finMcp.handler(req, res)).catch(next); });
    app.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'POST a JSON-RPC request.' }));
    app.use(auth ? auth.optionalAuth() : (_req, _res, next) => next());
    app.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

    // The pages and the API: the person's own sign-in only. A delegated token (something acting for them) is for /mcp.
    const { isDelegated } = require('openvibe-sdk/auth/delegated');
    const who = (req) => (req.user && !isDelegated(req.user) && /^usr_/.test(String(req.user.subject_id || '')) ? String(req.user.subject_id) : null);
    const own = new URL(baseUrl).origin;
    const sameOrigin = (req) => {
        if (/^Bearer\s/i.test(String(req.get('authorization') || ''))) return true;
        const site = req.get('sec-fetch-site');
        if (site) return site === 'same-origin';
        const origin = req.get('origin');
        return !origin || origin === own;
    };
    const form = express.urlencoded({ extended: false, limit: '4mb' });
    const handle = (fn) => async (req, res, next) => {
        try { await fn(req, res); } catch (err) {
            // Under the /api/v1 router req.path is relative to it: the mount (baseUrl) says it is the API.
            if (err instanceof FinanceError) return `${req.baseUrl}${req.path}`.startsWith('/api/') ? res.status(err.status).json({ error: err.message, code: err.code }) : res.status(err.status).send(v.page({ title: 'Something is wrong', body: `<p class="fin-error" role="alert">${v.esc(err.message)}</p><p><a href="/">Back</a></p>` }));
            next(err);
        }
    };
    const signIn = (req, res) => res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
    const thisMonth = () => now().toISOString().slice(0, 7);
    const monthOf = (q) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(q || '')) ? String(q) : thisMonth());
    const said = (q) => {
        if (q.imported) { const [a, s] = String(q.imported).split(','); return `Imported ${Number(a) || 0} new transaction${Number(a) === 1 ? '' : 's'}${Number(s) ? `; ${Number(s)} already here` : ''}.`; }
        if (q.ruled != null) return `Rule made. It also put ${Number(q.ruled) || 0} earlier transaction${Number(q.ruled) === 1 ? '' : 's'} in that category.`;
        if (q.goal) return 'Goal added.';
        if (q.debt) return 'Saved.';
        if (q.budgeted) return 'Budget saved.';
        if (q.unbudgeted) return 'Budget removed.';
        if (q.added) return 'Added.';
        if (q.removed) return 'Rule removed. What it categorised stays as it is.';
        if (q.deleted) return 'Everything is deleted.';
        return '';
    };
    /** A typed amount and its direction → signed cents, or null. */
    const amountOf = (text, direction) => { const c = readAmount(text); return c == null ? null : (direction === 'in' ? Math.abs(c) : -Math.abs(c)); };

    // ── Pages ──
    app.get('/', handle(async (req, res) => {
        const me = who(req);
        if (!me) return res.send(v.welcome());
        res.send(v.home({ accounts: await store.accounts(me), month: await store.month(me, thisMonth()), o: { said: said(req.query) } }));
    }));
    app.post('/accounts', form, handle(async (req, res) => {
        const me = who(req);
        if (!me) return signIn(req, res);
        if (!sameOrigin(req)) return res.status(403).send('A change must come from openvibe.finance itself.');
        const opening = String(req.body.opening || '').trim() ? readAmount(req.body.opening) : 0;
        if (opening == null) return res.status(422).send(v.home({ accounts: await store.accounts(me), month: await store.month(me, thisMonth()), o: { error: 'The opening balance is not a number.' } }));
        const acc = await store.addAccount(me, { name: req.body.name, kind: req.body.kind, currency: req.body.currency, opening_cents: opening });
        res.redirect(303, `/accounts/${acc.id}?added=1`);
    }));
    app.get('/accounts/:id', handle(async (req, res) => {
        const me = who(req);
        if (!me) return signIn(req, res);
        const account = await store.account(me, req.params.id);
        if (!account) return res.status(404).send(v.page({ title: 'No such account', body: '<h1>No such account of yours</h1><p><a href="/">Your money</a></p>' }));
        const month = monthOf(req.query.m);
        const all = (await store.accounts(me)).find((a) => a.id === account.id);
        res.send(v.accountPage({ account, balance: all ? all.balance_cents : account.opening_cents, txns: await store.transactions(me, account.id, { month }), month, o: { said: said(req.query) } }));
    }));
    app.post('/accounts/:id/transactions', form, handle(async (req, res) => {
        const me = who(req);
        if (!me) return signIn(req, res);
        if (!sameOrigin(req)) return res.status(403).send('A change must come from openvibe.finance itself.');
        const cents = amountOf(req.body.amount, req.body.direction);
        if (cents == null) throw new FinanceError(422, 'finance.transaction.amount', 'The amount is not a number.');
        const t = await store.addTransaction(me, req.params.id, { posted_on: req.body.posted_on, amount_cents: cents, payee: req.body.payee, category: req.body.category });
        res.redirect(303, `/accounts/${encodeURIComponent(req.params.id)}?m=${t.posted_on.slice(0, 7)}&added=1`);
    }));
    app.post('/accounts/:id/import', form, handle(async (req, res) => {
        const me = who(req);
        if (!me) return signIn(req, res);
        if (!sameOrigin(req)) return res.status(403).send('A change must come from openvibe.finance itself.');
        const read = readExport(req.body.csv);
        if (read.problem) throw new FinanceError(422, 'finance.import.unreadable', read.problem);
        const out = await store.importRows(me, req.params.id, read.rows);
        const latest = read.rows.map((r) => r.posted_on).sort().pop();
        res.redirect(303, `/accounts/${encodeURIComponent(req.params.id)}?m=${latest.slice(0, 7)}&imported=${out.added},${out.skipped}`);
    }));
    app.post('/transactions/:id/category', form, handle(async (req, res) => {
        const me = who(req);
        if (!me) return signIn(req, res);
        if (!sameOrigin(req)) return res.status(403).send('A change must come from openvibe.finance itself.');
        const t = await store.setCategory(me, req.params.id, req.body.category);
        let ruled = '';
        if (req.body.always === 'yes' && t.payee && t.category !== 'Uncategorized') ruled = `&ruled=${(await store.addRule(me, { match: t.payee, category: t.category })).applied}`;
        res.redirect(303, `/accounts/${encodeURIComponent(t.account_id)}?m=${t.posted_on.slice(0, 7)}${ruled}`);
    }));
    app.get('/month', handle(async (req, res) => {
        const me = who(req);
        if (!me) return signIn(req, res);
        res.send(v.monthPage({ m: await store.month(me, monthOf(req.query.m)), budgets: await store.budgets(me), o: { said: said(req.query) } }));
    }));
    app.get('/bills', handle(async (req, res) => {
        const me = who(req);
        if (!me) return signIn(req, res);
        const today = now().toISOString().slice(0, 10);
        res.send(v.billsPage({ found: findRecurring(await store.recent(me), { today }), today }));
    }));
    const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
    const addMonths = (m, by) => { const d = new Date(`${m}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + by); return d.toISOString().slice(0, 7); };
    /** The question asked (all optional): a one-off cost in a month, a monthly change from a month. → the ask, or throws. */
    function readAsk(q, months) {
        const amount = (text, what) => {
            const t = String(text || '').trim();
            if (!t) return 0;
            const c = readAmount(t);
            if (c == null) throw new FinanceError(422, 'finance.ahead.amount', `${what} is not a number.`);
            return Math.abs(c);
        };
        const when = (text, what) => {
            const t = String(text || '').trim();
            if (!t) return null;
            if (!MONTH_RE.test(t)) throw new FinanceError(422, 'finance.ahead.month', `${what} is a month (YYYY-MM).`);
            if (t > months[months.length - 1]) throw new FinanceError(422, 'finance.ahead.month', `${what} is within the next twelve months.`);
            return t < months[0] ? months[0] : t;
        };
        const change = amount(q.change, 'The monthly change');
        return {
            cost_cents: amount(q.cost, 'The cost'), cost_on: when(q.cost_on, 'When it is paid'),
            change_cents: q.dir === 'in' ? change : -change, change_from: when(q.from, 'When the change starts'),
        };
    }
    /** Net worth over the last twelve months and the average month repeated over the next twelve, with the ask. */
    async function aheadFor(me, q = {}) {
        const today = now().toISOString().slice(0, 10), m = today.slice(0, 7);
        const next = Array.from({ length: 12 }, (_, i) => addMonths(m, i + 1));
        const data = await store.ahead(me);
        // The line starts where the data does (an opening balance is "before the first transaction", not a year ago).
        const firstMove = data.moves.reduce((lo, x) => (x.month < lo ? x.month : lo), m);
        const past = Array.from({ length: 12 }, (_, i) => addMonths(m, i - 11)).filter((pm) => pm >= firstMove);
        const recent = [];
        for (const pm of [addMonths(m, -3), addMonths(m, -2), addMonths(m, -1)]) recent.push(await store.month(me, pm));
        const avg = ahead.averageMonth(recent);
        // What can be spent: checking, savings and cash, less what the cards owe (they are paid from it).
        const spendable = data.accounts.reduce((n, a) => n + (['checking', 'savings', 'cash'].includes(a.kind) ? a.balance_cents : a.kind === 'credit' ? Math.min(0, a.balance_cents) : 0), 0);
        let ask = null, error = null;
        try { ask = readAsk(q, next); } catch (err) { if (!(err instanceof FinanceError)) throw err; error = err.message; }
        const asked = Boolean(ask && (ask.cost_cents || ask.change_cents));
        const goalsNeed = (await store.goals(me)).reduce((n, g) => n + (perMonth({ target_cents: g.target_cents, have_cents: g.have_cents, target_on: g.target_on, today }) || 0), 0);
        return {
            net_worth: ahead.history({ accounts: data.accounts, moves: data.moves, months: past }),
            average: avg, spendable_cents: spendable, goals_need_cents: goalsNeed, has_accounts: data.accounts.length > 0,
            asked, ask, error,
            plan: avg.months.length ? ahead.whatIf({ start_cents: spendable, income_cents: avg.income_cents, spending_cents: avg.spending_cents, months: next, ...(asked ? ask : {}) }) : null,
        };
    }
    app.get('/ahead', handle(async (req, res) => {
        const me = who(req);
        if (!me) return signIn(req, res);
        res.send(v.aheadPage({ ...(await aheadFor(me, req.query)), q: req.query }));
    }));
    app.get('/goals', handle(async (req, res) => {
        const me = who(req);
        if (!me) return signIn(req, res);
        res.send(v.goalsPage({ goals: await store.goals(me), accounts: await store.accounts(me), today: now().toISOString().slice(0, 10), o: { said: said(req.query) } }));
    }));
    const writer = (fn) => [form, handle(async (req, res) => {
        const me = who(req);
        if (!me) return signIn(req, res);
        if (!sameOrigin(req)) return res.status(403).send('A change must come from openvibe.finance itself.');
        await fn(me, req, res);
    })];
    const cents = (text, what) => { const c = readAmount(text); if (c == null) throw new FinanceError(422, 'finance.amount', `${what} is not a number.`); return Math.abs(c); };
    app.post('/goals', ...writer(async (me, req, res) => {
        await store.addGoal(me, { name: req.body.name, target_cents: cents(req.body.target, 'The amount'), target_on: req.body.target_on || null, account_id: req.body.account || null });
        res.redirect(303, '/goals?goal=1');
    }));
    app.post('/goals/:id/saved', ...writer(async (me, req, res) => { await store.setGoalSaved(me, req.params.id, cents(req.body.saved, 'Saved so far')); res.redirect(303, '/goals'); }));
    app.post('/goals/:id/delete', ...writer(async (me, req, res) => { await store.removeGoal(me, req.params.id); res.redirect(303, '/goals'); }));
    app.post('/accounts/:id/debt', ...writer(async (me, req, res) => {
        const aprText = String(req.body.apr || '').trim(), payText = String(req.body.payment || '').trim();
        const apr = aprText ? Math.round(Number(aprText.replace('%', '')) * 100) : null;
        if (aprText && !Number.isFinite(apr)) throw new FinanceError(422, 'finance.debt.rate', 'The rate is not a number.');
        await store.setDebt(me, req.params.id, { apr_bps: apr, payment_cents: payText ? cents(payText, 'The payment') : null });
        res.redirect(303, '/goals?debt=1');
    }));
    app.get('/rules', handle(async (req, res) => {
        const me = who(req);
        if (!me) return signIn(req, res);
        res.send(v.rulesPage({ rules: await store.rules(me), o: { said: said(req.query) } }));
    }));
    app.post('/rules/:id/delete', form, handle(async (req, res) => {
        const me = who(req);
        if (!me) return signIn(req, res);
        if (!sameOrigin(req)) return res.status(403).send('A change must come from openvibe.finance itself.');
        await store.removeRule(me, req.params.id);
        res.redirect(303, '/rules?removed=1');
    }));
    app.post('/budgets', form, handle(async (req, res) => {
        const me = who(req);
        if (!me) return signIn(req, res);
        if (!sameOrigin(req)) return res.status(403).send('A change must come from openvibe.finance itself.');
        const text = String(req.body.amount || '').trim();
        const cents = text ? readAmount(text) : null;
        if (text && cents == null) throw new FinanceError(422, 'finance.budget.amount', 'The budget is not a number.');
        await store.setBudget(me, req.body.category, cents == null ? null : Math.abs(cents));
        const back = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.body.back || '')) ? String(req.body.back) : thisMonth();
        res.redirect(303, `/month?m=${back}&${cents ? 'budgeted' : 'unbudgeted'}=1`);
    }));
    app.get('/data', handle(async (req, res) => {
        if (!who(req)) return signIn(req, res);
        res.send(v.dataPage({ o: { said: said(req.query) } }));
    }));
    app.get('/data/export', handle(async (req, res) => {
        const me = who(req);
        if (!me) return signIn(req, res);
        res.set('Content-Disposition', `attachment; filename="openvibe-finance-${thisMonth()}.json"`);
        res.json(await store.exportAll(me));
    }));
    app.post('/data/delete', form, handle(async (req, res) => {
        const me = who(req);
        if (!me) return signIn(req, res);
        if (!sameOrigin(req)) return res.status(403).send('A change must come from openvibe.finance itself.');
        if (req.body.sure !== 'yes') return res.status(422).send(v.dataPage({ o: { error: 'Tick the box to say you are sure.' } }));
        await store.removeAll(me);
        res.redirect(303, '/data?deleted=1');
    }));

    // ── API (JSON) ──
    const api = express.Router();
    api.use((req, res, next) => { if (!who(req)) return res.status(401).json({ error: 'Sign in first.', code: 'finance.person' }); if (req.method !== 'GET' && !sameOrigin(req)) return res.status(403).json({ error: 'Cross-site writes are refused.', code: 'finance.cross_site' }); next(); });
    api.get('/accounts', handle(async (req, res) => res.json({ accounts: await store.accounts(who(req)) })));
    api.post('/accounts', express.json({ limit: '16kb' }), handle(async (req, res) => res.status(201).json(await store.addAccount(who(req), req.body || {}))));
    api.get('/accounts/:id/transactions', handle(async (req, res) => {
        if (!(await store.account(who(req), req.params.id))) throw new FinanceError(404, 'finance.account.not_found', 'No such account of yours.');
        res.json({ transactions: await store.transactions(who(req), req.params.id, { month: req.query.m ? String(req.query.m) : null }) });
    }));
    api.post('/accounts/:id/transactions', express.json({ limit: '16kb' }), handle(async (req, res) => res.status(201).json(await store.addTransaction(who(req), req.params.id, req.body || {}))));
    api.post('/accounts/:id/import', express.text({ type: ['text/csv', 'text/plain', 'application/x-ofx', 'application/vnd.intu.qfx', 'application/ofx'], limit: '4mb' }), handle(async (req, res) => {
        const read = readExport(typeof req.body === 'string' ? req.body : '');
        if (read.problem) throw new FinanceError(422, 'finance.import.unreadable', read.problem);
        res.status(201).json({ ...(await store.importRows(who(req), req.params.id, read.rows)), unreadable: read.skipped.slice(0, 50) });
    }));
    api.get('/months/:m', handle(async (req, res) => res.json(await store.month(who(req), req.params.m))));
    api.get('/rules', handle(async (req, res) => res.json({ rules: await store.rules(who(req)) })));
    api.get('/budgets', handle(async (req, res) => res.json({ budgets: await store.budgets(who(req)) })));
    api.get('/goals', handle(async (req, res) => res.json({ goals: await store.goals(who(req)) })));
    api.get('/net-worth', handle(async (req, res) => { const a = await aheadFor(who(req)); res.json({ net_worth: a.net_worth }); }));
    api.get('/what-if', handle(async (req, res) => {
        const a = await aheadFor(who(req), req.query);
        if (a.error) throw new FinanceError(422, 'finance.ahead.ask', a.error);
        res.json({ average: a.average, spendable_cents: a.spendable_cents, goals_need_cents: a.goals_need_cents, ask: a.asked ? a.ask : null, plan: a.plan });
    }));
    api.post('/goals', express.json({ limit: '4kb' }), handle(async (req, res) => res.status(201).json(await store.addGoal(who(req), req.body || {}))));
    api.put('/budgets/:category', express.json({ limit: '2kb' }), handle(async (req, res) => {
        const cents = req.body && req.body.monthly_cents;
        res.json({ budget: await store.setBudget(who(req), decodeURIComponent(req.params.category), cents == null ? null : Number(cents)) });
    }));
    api.get('/recurring', handle(async (req, res) => res.json({ recurring: findRecurring(await store.recent(who(req)), { today: now().toISOString().slice(0, 10) }).map(({ key, ...r }) => r) })));
    api.post('/rules', express.json({ limit: '4kb' }), handle(async (req, res) => res.status(201).json(await store.addRule(who(req), req.body || {}))));
    api.delete('/rules/:id', handle(async (req, res) => { await store.removeRule(who(req), req.params.id); res.status(204).end(); }));
    api.get('/export', handle(async (req, res) => res.json(await store.exportAll(who(req)))));
    app.use('/api/v1', api);

    app.use((_req, res) => res.status(404).send(v.page({ title: 'Not here', body: '<h1>Not here</h1><p><a href="/">Your money</a></p>' })));
    app.use((err, _req, res, _next) => { console.error('[finance]', err && err.message); res.status(500).send('Something went wrong on our side.'); });
    return app;
}

module.exports = { createApp };
