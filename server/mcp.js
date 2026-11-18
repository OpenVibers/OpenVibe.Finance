'use strict';
/**
 * Finance's MCP server, POST /mcp (plan §L.2: "all through an SDK, with Finance Experts on top … an Expert gets narrow
 * permissions (transactions.read), never a bank login"). An agent the person allowed reads their money as them, and
 * nothing more:
 *
 * - **Read only.** Every tool is readOnlyHint; none writes, imports, deletes or moves money. "No money moves."
 * - **As the person, by a Bearer token only:** their own session's, or a delegated person token (SDK 0.187) that names
 *   this service, which OpenVibe.Network mints per call for a key with a grant in OpenVibe Finance (Connect, /mcp/all).
 *   Cookies are never read here, so a page elsewhere cannot use a signed-in browser. The pages and the JSON API keep
 *   refusing delegated tokens (their sign-in client does not take them).
 * - **Both MCP eras on one endpoint** (openvibe-sdk/mcp): 2026-07-28 (stateless, _meta version) and the handshake era.
 * - tools/list answers anyone (names and schemas only); tools/call without a person says to connect Finance.
 *
 *   createMcp({ store, aheadFor, now }) → { tools, handler(req, res) }   req.user is the person (or nobody)
 */
const mcp = require('openvibe-sdk/mcp');
const { FinanceError } = require('./store');
const { findRecurring } = require('./recurring');
const { payoff } = require('./plan');

const SERVER_INFO = { name: 'openvibe-finance', title: 'OpenVibe Finance', version: require('../package.json').version };
const INSTRUCTIONS = 'Read one person\'s money on OpenVibe Finance, as them: accounts and balances, a month by category with budgets, '
    + 'transactions, recurring bills and income, goals and debt payoff, net worth over time, and what-if ("can I afford this?"). '
    + 'Amounts are integer cents; months are YYYY-MM. Read only: nothing here moves money or changes anything.';
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const MONTH = { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$', description: 'A month, YYYY-MM.' };
const tool = (name, title, description, properties = {}) => ({
    name, title, description,
    inputSchema: { type: 'object', properties, additionalProperties: false },
    annotations: { title, ...READ },
});

const TOOLS = [
    tool('accounts', 'Your accounts', 'Every account with its kind, currency, balance (cents), and for a loan or card its yearly rate (basis points) and monthly payment.'),
    tool('month', 'A month by category', 'Money in and out for a month (this month by default) by category, with each category\'s monthly budget, what is left of it or how much over. Transfers between the person\'s accounts are left out.', { month: MONTH }),
    tool('transactions', 'Transactions', 'Transactions, newest first: date, amount (cents; negative is money out), payee, memo, category and where the category came from (none, you, rule, file). One account or all; one month or the latest.', {
        account_id: { type: 'string', maxLength: 64, description: 'One account (from accounts); all accounts when left out.' },
        month: MONTH, limit: { type: 'integer', minimum: 1, maximum: 500, description: 'At most this many (100 by default).' },
    }),
    tool('recurring', 'Recurring bills and income', 'Bills, subscriptions and regular income found in the last year: payee, cadence, typical amount, the next date, what it costs a month, and whether it is overdue.'),
    tool('goals', 'Goals and debt', 'Goals (target, by when, how much there is) and debts (loans and cards owed, their rate and payment, when they are paid off and the interest it costs).'),
    tool('net_worth', 'Net worth over time', 'Net worth at the end of each month since the data starts (assets, owed, net, in cents).'),
    tool('what_if', 'What if', 'The person\'s average month (the last three, transfers left out) repeated a year ahead from what they can spend now, with an optional one-off cost ("can I afford this?") and an optional monthly change ("what if rent rises?"). Answers each month\'s money to spend with and without it, the lowest point, the first month below zero, and when a cost that does not fit yet would.', {
        cost_cents: { type: 'integer', minimum: 0, maximum: 1e11, description: 'A one-off cost.' },
        cost_on: { ...MONTH, description: 'The month it is paid (next month by default), within the next twelve.' },
        change_cents: { type: 'integer', minimum: 0, maximum: 1e11, description: 'A change every month.' },
        direction: { type: 'string', enum: ['out', 'in'], description: 'out: more going out (rent rises); in: more coming in. out by default.' },
        from: { ...MONTH, description: 'The month the change starts (next month by default).' },
    }),
];

function createMcp({ store, aheadFor, now = () => new Date() }) {
    const today = () => now().toISOString().slice(0, 10);

    const RUN = {
        async accounts(me) {
            return { accounts: (await store.accounts(me)).map((a) => ({ id: a.id, name: a.name, kind: a.kind, currency: a.currency, balance_cents: a.balance_cents, apr_bps: a.apr_bps, payment_cents: a.payment_cents, transactions: a.count, last_on: a.last_on })) };
        },
        async month(me, args) {
            const m = await store.month(me, args.month || today().slice(0, 7));
            const limit = new Map((await store.budgets(me)).map((b) => [b.category, b.monthly_cents]));
            return {
                month: m.month, income_cents: m.income_cents, spent_cents: m.spent_cents,
                by_category: m.by_category.map((c) => ({ category: c.category, in_cents: c.in_cents, out_cents: c.out_cents, count: c.count,
                    ...(limit.has(c.category) ? { budget_cents: limit.get(c.category), left_cents: limit.get(c.category) - c.out_cents } : {}) })),
                budgets_unspent: [...limit].filter(([cat]) => !m.by_category.some((c) => c.category === cat)).map(([category, cents]) => ({ category, budget_cents: cents, left_cents: cents })),
            };
        },
        async transactions(me, args) {
            const limit = args.limit || 100;
            const ids = args.account_id ? [String(args.account_id)] : (await store.accounts(me)).map((a) => a.id);
            if (args.account_id && !(await store.account(me, args.account_id))) throw new FinanceError(404, 'finance.account.not_found', 'No such account of yours.');
            const all = [];
            for (const id of ids) all.push(...await store.transactions(me, id, { month: args.month || null, limit }));
            all.sort((a, b) => (a.posted_on < b.posted_on ? 1 : a.posted_on > b.posted_on ? -1 : 0));
            return { transactions: all.slice(0, limit).map((t) => ({ id: t.id, account_id: t.account_id, posted_on: t.posted_on, amount_cents: t.amount_cents, payee: t.payee, memo: t.memo, category: t.category, category_from: t.category_from })) };
        },
        async recurring(me) {
            return { recurring: findRecurring(await store.recent(me), { today: today() }).map(({ key, ...r }) => r) };
        },
        async goals(me) {
            const accounts = await store.accounts(me);
            return {
                goals: (await store.goals(me)).map((g) => ({ name: g.name, target_cents: g.target_cents, target_on: g.target_on, have_cents: g.have_cents, tracks_account_id: g.account_id })),
                debts: accounts.filter((a) => a.kind === 'loan' || a.kind === 'credit').map((a) => {
                    const owed = Math.max(0, -a.balance_cents);
                    const p = owed && a.apr_bps != null && a.payment_cents ? payoff({ owed_cents: owed, apr_bps: a.apr_bps, payment_cents: a.payment_cents }) : null;
                    return { account_id: a.id, name: a.name, owed_cents: owed, apr_bps: a.apr_bps, payment_cents: a.payment_cents, payoff_months: p && !p.never ? p.months : null, interest_cents: p && !p.never ? p.interest_cents : null, never_paid_off: Boolean(p && p.never) };
                }),
            };
        },
        async net_worth(me) {
            return { net_worth: (await aheadFor(me)).net_worth };
        },
        async what_if(me, args) {
            const q = {};
            if (args.cost_cents) q.cost = (args.cost_cents / 100).toFixed(2);
            if (args.cost_on) q.cost_on = args.cost_on;
            if (args.change_cents) q.change = (args.change_cents / 100).toFixed(2);
            if (args.direction) q.dir = args.direction;
            if (args.from) q.from = args.from;
            const a = await aheadFor(me, q);
            if (a.error) throw new FinanceError(422, 'finance.ahead.ask', a.error);
            if (!a.plan) return { average: a.average, plan: null, note: 'Not enough history: the months before this one have no transactions.' };
            return { average: a.average, spendable_cents: a.spendable_cents, goals_need_cents: a.goals_need_cents, plan: a.plan };
        },
    };

    /** The arguments against the tool's schema: only its own keys, the right types, in range. → a message or null. */
    function badArgs(def, args) {
        if (!args || typeof args !== 'object' || Array.isArray(args)) return 'The arguments are an object.';
        const props = def.inputSchema.properties;
        for (const [k, v] of Object.entries(args)) {
            const p = props[k];
            if (!p) return `${def.name} takes no "${k}".`;
            if (p.type === 'integer' && (!Number.isSafeInteger(v) || v < (p.minimum ?? -Infinity) || v > (p.maximum ?? Infinity))) return `"${k}" is a whole number${p.maximum ? ` from ${p.minimum} to ${p.maximum}` : ''}.`;
            if (p.type === 'string' && (typeof v !== 'string' || (p.maxLength && v.length > p.maxLength) || (p.pattern && !new RegExp(p.pattern).test(v)) || (p.enum && !p.enum.includes(v)))) return `"${k}" is not right: ${p.description || 'see the schema'}`;
        }
        return null;
    }

    const asResult = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
    const asError = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

    async function call(req, params) {
        const def = TOOLS.find((t) => t.name === String(params && params.name));
        if (!def) return { error: { code: mcp.ERRORS.invalidParams, message: `No tool named ${String(params && params.name)}.` } };
        const me = req.user && /^usr_/.test(String(req.user.subject_id || '')) ? String(req.user.subject_id) : null;
        if (!me) return { result: asError('Finance reads your money as you: connect OpenVibe Finance (a grant on your Apps page) or call with your own sign-in.') };
        const args = params.arguments == null ? {} : params.arguments;
        const bad = badArgs(def, args);
        if (bad) return { result: asError(bad) };
        try { return { result: asResult(await RUN[def.name](me, args)) }; } catch (err) {
            if (err instanceof FinanceError) return { result: asError(err.message) };
            throw err;
        }
    }

    async function handler(req, res) {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const id = Object.prototype.hasOwnProperty.call(body, 'id') ? body.id : null;
        const method = body.method;
        const params = body.params && typeof body.params === 'object' ? body.params : {};
        const reply = (result, status = 200) => res.status(status).json({ jsonrpc: '2.0', id, result });
        const fail = (status, error) => res.status(status).json({ jsonrpc: '2.0', id, error });
        if (body.jsonrpc !== '2.0' || typeof method !== 'string') return fail(400, { code: mcp.ERRORS.invalidRequest, message: 'A JSON-RPC 2.0 request.' });
        const modern = mcp.requestVersion(params);
        if (modern) {
            const bad = mcp.checkRequest({ header: (n) => req.get(n), method, params });
            if (bad) return fail(bad.status, bad.error);
        }
        if (!Object.prototype.hasOwnProperty.call(body, 'id') || method.startsWith('notifications/')) return res.status(202).end();
        switch (method) {
            case 'initialize':
                return reply({ protocolVersion: mcp.legacyVersion(params.protocolVersion), capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
            case 'server/discover':
                return reply(mcp.discoverResult({ serverInfo: SERVER_INFO, capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS }));
            case 'ping':
                return reply(modern ? mcp.complete({}) : {});
            case 'tools/list':
                return reply(modern ? mcp.listResult('tools', TOOLS, { cacheScope: 'public' }) : { tools: TOOLS });
            case 'tools/call': {
                const out = await call(req, params);
                if (out.error) return fail(200, out.error);
                return reply(modern ? mcp.complete(out.result) : out.result);
            }
            default: {
                const nf = mcp.methodNotFound(method);
                return fail(nf.status, nf.error);
            }
        }
    }

    return { tools: TOOLS, handler };
}

module.exports = { createMcp, TOOLS };
