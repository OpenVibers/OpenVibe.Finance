'use strict';
/**
 * OpenVibe.Finance (plan §L.2): the pages and the JSON API over one person's accounts and transactions.
 *
 *   createApp({ db, vault, auth, baseUrl }) → an Express app
 *     auth: openvibe-sdk/sso's client (router, optionalAuth); tests pass a stand-in that sets req.user.
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
const { findRecurring } = require('./recurring');
const v = require('./views');

function createApp({ db, vault, auth, baseUrl = 'https://openvibe.finance', now = () => new Date() }) {
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
    app.use(auth ? auth.optionalAuth() : (_req, _res, next) => next());
    app.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

    const who = (req) => (req.user && /^usr_/.test(String(req.user.subject_id || '')) ? String(req.user.subject_id) : null);
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
            if (err instanceof FinanceError) return req.path.startsWith('/api/') ? res.status(err.status).json({ error: err.message, code: err.code }) : res.status(err.status).send(v.page({ title: 'Something is wrong', body: `<p class="fin-error" role="alert">${v.esc(err.message)}</p><p><a href="/">Back</a></p>` }));
            next(err);
        }
    };
    const signIn = (req, res) => res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
    const thisMonth = () => now().toISOString().slice(0, 7);
    const monthOf = (q) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(q || '')) ? String(q) : thisMonth());
    const said = (q) => {
        if (q.imported) { const [a, s] = String(q.imported).split(','); return `Imported ${Number(a) || 0} new transaction${Number(a) === 1 ? '' : 's'}${Number(s) ? `; ${Number(s)} already here` : ''}.`; }
        if (q.ruled != null) return `Rule made. It also put ${Number(q.ruled) || 0} earlier transaction${Number(q.ruled) === 1 ? '' : 's'} in that category.`;
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
        const read = readCsv(req.body.csv);
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
        res.send(v.monthPage({ m: await store.month(me, monthOf(req.query.m)) }));
    }));
    app.get('/bills', handle(async (req, res) => {
        const me = who(req);
        if (!me) return signIn(req, res);
        const today = now().toISOString().slice(0, 10);
        res.send(v.billsPage({ found: findRecurring(await store.recent(me), { today }), today }));
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
    api.post('/accounts/:id/import', express.text({ type: ['text/csv', 'text/plain'], limit: '4mb' }), handle(async (req, res) => {
        const read = readCsv(typeof req.body === 'string' ? req.body : '');
        if (read.problem) throw new FinanceError(422, 'finance.import.unreadable', read.problem);
        res.status(201).json({ ...(await store.importRows(who(req), req.params.id, read.rows)), unreadable: read.skipped.slice(0, 50) });
    }));
    api.get('/months/:m', handle(async (req, res) => res.json(await store.month(who(req), req.params.m))));
    api.get('/rules', handle(async (req, res) => res.json({ rules: await store.rules(who(req)) })));
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
