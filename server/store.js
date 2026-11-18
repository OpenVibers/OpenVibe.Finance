'use strict';
/**
 * A person's accounts and transactions (migrations/0001_finance.sql). Every function takes the person (owner, a usr_
 * subject) and reads or writes only their rows; payees and memos are sealed with their key (server/crypto.js) on the
 * way in and opened on the way out.
 *
 *   const store = createStore({ db, vault });
 *   accounts(owner)                         → [{ id, name, kind, currency, balance_cents, count, last_on }]
 *   account(owner, id)                      → one, or null
 *   addAccount(owner, { name, kind, currency, opening_cents })
 *   transactions(owner, accountId, { month }) → [{ id, posted_on, amount_cents, payee, memo, category, category_from }]
 *   addTransaction(owner, accountId, { posted_on, amount_cents, payee, memo, category })
 *   setCategory(owner, id, category)        a correction: a new revision, category_from 'you'
 *   removeTransaction(owner, id)
 *   importRows(owner, accountId, rows)      → { import_id, read, added, skipped } (the same row twice is one)
 *   month(owner, 'YYYY-MM')                 → { month, income_cents, spent_cents, by_category: [{ category, cents, count }] }
 *   rules(owner)                            → [{ id, match, category }] (longest words first)
 *   addRule(owner, { match, category })     the same words again replace the category; applied to the past
 *   removeRule(owner, id)
 *   exportAll(owner)                        → everything, opened (the person's own copy)
 *   removeAll(owner)                        → everything of theirs deleted
 */
const crypto = require('node:crypto');

const KINDS = ['checking', 'savings', 'credit', 'cash', 'loan', 'investment', 'other'];
const CATEGORIES = ['Income', 'Housing', 'Utilities', 'Groceries', 'Eating out', 'Transport', 'Health', 'Insurance', 'Shopping',
    'Subscriptions', 'Entertainment', 'Travel', 'Education', 'Gifts and giving', 'Fees', 'Transfers', 'Savings', 'Debt payments', 'Taxes', 'Other', 'Uncategorized'];
const newId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

class FinanceError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new FinanceError(status, code, message); };

function cleanCategory(c) {
    const t = String(c || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return t || 'Uncategorized';
}

/** Words for matching: lower case, one space, no digits-only runs (card and reference numbers change every time). */
const matchable = (t) => String(t || '').toLowerCase().replace(/\b\d{3,}\b/g, ' ').replace(/[^a-z0-9&'.\- ]+/g, ' ').replace(/\s+/g, ' ').trim();

function createStore({ db, vault }) {
    const own = (owner) => { if (!/^usr_[0-9A-Za-z]{10,40}$/.test(String(owner || ''))) fail(401, 'finance.person', 'Sign in first.'); return owner; };
    const open = (owner, row) => ({
        id: row.id, account_id: row.account_id, posted_on: row.posted_on, amount_cents: Number(row.amount_cents),
        payee: vault.open(owner, row.payee_enc), memo: vault.open(owner, row.memo_enc),
        category: row.category, category_from: row.category_from, revision: row.revision,
    });

    async function accounts(owner) {
        own(owner);
        const rows = await db.many(`SELECT a.id, a.name, a.kind, a.currency, a.opening_cents,
                COALESCE(SUM(t.amount_cents), 0)::bigint AS moved, COUNT(t.id)::int AS count, MAX(t.posted_on) AS last_on
            FROM finance_accounts a LEFT JOIN finance_transactions t ON t.account_id = a.id
            WHERE a.owner = $1 AND a.archived_at IS NULL GROUP BY a.id ORDER BY a.created_at, a.id`, [owner]);
        return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, currency: r.currency, balance_cents: Number(r.opening_cents) + Number(r.moved), count: r.count, last_on: r.last_on || null }));
    }

    async function account(owner, id) {
        own(owner);
        const r = await db.maybe('SELECT id, name, kind, currency, opening_cents FROM finance_accounts WHERE id = $1 AND owner = $2 AND archived_at IS NULL', [String(id || ''), owner]);
        return r ? { ...r, opening_cents: Number(r.opening_cents) } : null;
    }

    async function addAccount(owner, input = {}) {
        own(owner);
        const name = String(input.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!name) fail(422, 'finance.account.name', 'Give the account a name.');
        const kind = KINDS.includes(input.kind) ? input.kind : 'checking';
        const currency = /^[A-Z]{3}$/.test(String(input.currency || '').toUpperCase()) ? String(input.currency).toUpperCase() : 'USD';
        const opening = Number.isSafeInteger(input.opening_cents) ? input.opening_cents : 0;
        const count = Number(await db.value('SELECT count(*) FROM finance_accounts WHERE owner = $1 AND archived_at IS NULL', [owner]));
        if (count >= 100) fail(422, 'finance.account.limit', 'A hundred accounts is the most for now.');
        const id = newId('acc');
        await db.exec('INSERT INTO finance_accounts (id, owner, name, kind, currency, opening_cents) VALUES ($1, $2, $3, $4, $5, $6)', [id, owner, name, kind, currency, opening]);
        return account(owner, id);
    }

    async function transactions(owner, accountId, { month = null, limit = 500 } = {}) {
        own(owner);
        const args = [owner, String(accountId || '')];
        let where = 'owner = $1 AND account_id = $2';
        if (month) {
            if (!MONTH.test(month)) fail(422, 'finance.month', 'A month is YYYY-MM.');
            args.push(`${month}-01`);
            where += ` AND posted_on >= $3::date AND posted_on < ($3::date + interval '1 month')`;
        }
        const rows = await db.many(`SELECT * FROM finance_transactions WHERE ${where} ORDER BY posted_on DESC, created_at DESC, id LIMIT ${Math.max(1, Math.min(2000, Number(limit) || 500))}`, args);
        return rows.map((r) => open(owner, r));
    }

    function checkRow(input) {
        const posted_on = String(input.posted_on || '');
        if (!DAY.test(posted_on) || Number.isNaN(Date.parse(`${posted_on}T00:00:00Z`))) fail(422, 'finance.transaction.date', 'A date is YYYY-MM-DD.');
        if (!Number.isSafeInteger(input.amount_cents) || Math.abs(input.amount_cents) > 1e13) fail(422, 'finance.transaction.amount', 'An amount is a number of cents.');
        return {
            posted_on, amount_cents: input.amount_cents,
            payee: String(input.payee || '').replace(/\s+/g, ' ').trim().slice(0, 300),
            memo: String(input.memo || '').replace(/\s+/g, ' ').trim().slice(0, 500),
            category: cleanCategory(input.category),
        };
    }

    async function addTransaction(owner, accountId, input = {}) {
        own(owner);
        const acc = await account(owner, accountId);
        if (!acc) fail(404, 'finance.account.not_found', 'No such account of yours.');
        const r = checkRow(input);
        const id = newId('txn');
        await db.exec(`INSERT INTO finance_transactions (id, owner, account_id, posted_on, amount_cents, payee_enc, memo_enc, category, category_from)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, owner, acc.id, r.posted_on, r.amount_cents, vault.seal(owner, r.payee), vault.seal(owner, r.memo), r.category, r.category === 'Uncategorized' ? 'none' : 'you']);
        return open(owner, await db.one('SELECT * FROM finance_transactions WHERE id = $1', [id]));
    }

    async function setCategory(owner, id, category) {
        own(owner);
        const c = cleanCategory(category);
        const n = await db.exec(`UPDATE finance_transactions SET category = $3, category_from = 'you', revision = revision + 1, updated_at = now()
            WHERE id = $1 AND owner = $2`, [String(id || ''), owner, c]);
        if (!n) fail(404, 'finance.transaction.not_found', 'No such transaction of yours.');
        return open(owner, await db.one('SELECT * FROM finance_transactions WHERE id = $1', [String(id)]));
    }

    async function removeTransaction(owner, id) {
        own(owner);
        await db.exec('DELETE FROM finance_transactions WHERE id = $1 AND owner = $2', [String(id || ''), owner]);
    }

    async function importRows(owner, accountId, rows) {
        own(owner);
        const acc = await account(owner, accountId);
        if (!acc) fail(404, 'finance.account.not_found', 'No such account of yours.');
        const list = Array.isArray(rows) ? rows.slice(0, 20000) : [];
        const importId = newId('imp');
        const known = await rules(owner);
        let added = 0;
        await db.tx(async (t) => {
            await t.exec('INSERT INTO finance_imports (id, owner, account_id, format, rows_read) VALUES ($1, $2, $3, $4, $5)', [importId, owner, acc.id, 'csv', list.length]);
            // The same row twice in one file is two transactions (two coffees on one day); the same file twice is not.
            const seen = new Map();
            for (const input of list) {
                const r = checkRow(input);
                let from = r.category === 'Uncategorized' ? 'none' : 'file';
                if (from === 'none') { const hit = ruleFor(known, r.payee); if (hit) { r.category = hit.category; from = 'rule'; } }
                const key = `${acc.id}|${r.posted_on}|${r.amount_cents}|${r.payee.toLowerCase()}`;
                const nth = (seen.get(key) || 0) + 1;
                seen.set(key, nth);
                const out = await t.exec(`INSERT INTO finance_transactions (id, owner, account_id, posted_on, amount_cents, payee_enc, memo_enc, category, category_from, import_id, dedupe)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (account_id, dedupe) WHERE dedupe IS NOT NULL DO NOTHING`,
                [newId('txn'), owner, acc.id, r.posted_on, r.amount_cents, vault.seal(owner, r.payee), vault.seal(owner, r.memo), r.category,
                    from, importId, vault.mark(owner, `${key}|${nth}`)]);
                if (out) added++;
            }
            await t.exec('UPDATE finance_imports SET rows_added = $2, rows_skipped = $3 WHERE id = $1', [importId, added, list.length - added]);
        });
        return { import_id: importId, read: list.length, added, skipped: list.length - added };
    }

    async function month(owner, m) {
        own(owner);
        if (!MONTH.test(String(m || ''))) fail(422, 'finance.month', 'A month is YYYY-MM.');
        // In and out by each transaction's sign, never a category's net: a paycheck and a coffee in one category are $2,500
        // in and $4.50 out, not $2,495.50 in.
        const rows = await db.many(`SELECT t.category,
                SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents ELSE 0 END)::bigint AS in_cents,
                SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents ELSE 0 END)::bigint AS out_cents, COUNT(*)::int AS count
            FROM finance_transactions t JOIN finance_accounts a ON a.id = t.account_id AND a.archived_at IS NULL
            WHERE t.owner = $1 AND t.posted_on >= $2::date AND t.posted_on < ($2::date + interval '1 month') AND t.category <> 'Transfers'
            GROUP BY t.category ORDER BY 3 DESC, 2 DESC`, [owner, `${m}-01`]);
        let income = 0, spent = 0;
        const by = rows.map((r) => {
            const i = Number(r.in_cents), o = Number(r.out_cents);
            income += i; spent += o;
            return { category: r.category, in_cents: i, out_cents: o, cents: i - o, count: r.count };
        });
        return { month: m, income_cents: income, spent_cents: spent, by_category: by };
    }

    async function rules(owner) {
        own(owner);
        const rows = await db.many('SELECT id, match_enc, category FROM finance_rules WHERE owner = $1', [owner]);
        return rows.map((r) => ({ id: r.id, match: vault.open(owner, r.match_enc), category: r.category })).sort((a, b) => b.match.length - a.match.length);
    }
    /** The rule a payee falls under: the longest words it contains. */
    const ruleFor = (list, payee) => { const p = matchable(payee); return p ? list.find((r) => p.includes(r.match)) || null : null; };

    /** Put every uncategorised transaction of the person (or of one account) under the rules. → how many changed. */
    async function applyRules(owner, list = null) {
        const all = list || await rules(owner);
        if (!all.length) return 0;
        const rows = await db.many("SELECT id, payee_enc FROM finance_transactions WHERE owner = $1 AND category_from = 'none' LIMIT 20000", [owner]);
        let changed = 0;
        for (const r of rows) {
            const hit = ruleFor(all, vault.open(owner, r.payee_enc));
            if (!hit) continue;
            changed += await db.exec(`UPDATE finance_transactions SET category = $3, category_from = 'rule', revision = revision + 1, updated_at = now()
                WHERE id = $1 AND owner = $2 AND category_from = 'none'`, [r.id, owner, hit.category]);
        }
        return changed;
    }

    async function addRule(owner, input = {}) {
        own(owner);
        const match = matchable(input.match).slice(0, 120);
        if (match.length < 2) fail(422, 'finance.rule.match', 'A rule needs a few words of the payee.');
        const category = cleanCategory(input.category);
        if (category === 'Uncategorized') fail(422, 'finance.rule.category', 'Say which category it is.');
        const count = Number(await db.value('SELECT count(*) FROM finance_rules WHERE owner = $1', [owner]));
        const mark = vault.mark(owner, `rule|${match}`);
        const known = await db.maybe('SELECT id FROM finance_rules WHERE owner = $1 AND match_mark = $2', [owner, mark]);
        if (!known && count >= 500) fail(422, 'finance.rule.limit', 'Five hundred rules is the most for now.');
        const id = known ? known.id : newId('rul');
        await db.exec(`INSERT INTO finance_rules (id, owner, match_enc, match_mark, category) VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (owner, match_mark) DO UPDATE SET category = EXCLUDED.category`, [id, owner, vault.seal(owner, match), mark, category]);
        const applied = await applyRules(owner);
        return { id, match, category, applied };
    }

    async function removeRule(owner, id) {
        own(owner);
        await db.exec('DELETE FROM finance_rules WHERE id = $1 AND owner = $2', [String(id || ''), owner]);
    }

    async function exportAll(owner) {
        own(owner);
        const accs = await db.many('SELECT id, name, kind, currency, opening_cents, created_at, archived_at FROM finance_accounts WHERE owner = $1 ORDER BY created_at', [owner]);
        const txns = await db.many('SELECT * FROM finance_transactions WHERE owner = $1 ORDER BY posted_on, created_at', [owner]);
        return {
            exported_at: new Date().toISOString(), format: 'openvibe.finance.export@1',
            accounts: accs.map((a) => ({ ...a, opening_cents: Number(a.opening_cents) })),
            transactions: txns.map((r) => open(owner, r)),
            rules: (await rules(owner)).map((r) => ({ match: r.match, category: r.category })),
        };
    }

    async function removeAll(owner) {
        own(owner);
        await db.tx(async (t) => {
            await t.exec('DELETE FROM finance_transactions WHERE owner = $1', [owner]);
            await t.exec('DELETE FROM finance_imports WHERE owner = $1', [owner]);
            await t.exec('DELETE FROM finance_rules WHERE owner = $1', [owner]);
            await t.exec('DELETE FROM finance_accounts WHERE owner = $1', [owner]);
        });
    }

    return { accounts, account, addAccount, transactions, addTransaction, setCategory, removeTransaction, importRows, month, rules, addRule, removeRule, applyRules, exportAll, removeAll };
}

module.exports = { createStore, FinanceError, KINDS, CATEGORIES, matchable };
