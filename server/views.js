'use strict';
/**
 * Finance's pages, server-rendered in the network's shell (openvibe-shared/shell, kit.css) with this site's own
 * finance.css. Every value that reaches markup goes through esc(). Forms post to the same origin and work without
 * script; public/finance.js only reads a chosen CSV file into the paste box.
 */
const shell = require('openvibe-shared/shell');
const serve = require('openvibe-shared/serve');
const { CATEGORIES, KINDS } = require('./store');

const SITE = 'https://openvibe.finance';
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents, currency = 'USD') => {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100); }
    catch { return `${(cents / 100).toFixed(2)} ${currency}`; }
};
const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const shiftMonth = (m, by) => { const d = new Date(`${m}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + by); return d.toISOString().slice(0, 7); };
const KIND_WORDS = { checking: 'Checking', savings: 'Savings', credit: 'Credit card', cash: 'Cash', loan: 'Loan', investment: 'Investments', other: 'Other' };

function page({ title, body, path = '/', description = 'Your money, your rules, your data: accounts, imports and a monthly picture, private to you.', robots = 'noindex, nofollow' }) {
    return shell.page({
        name: 'OpenVibe.Finance', siteName: 'OpenVibe.Finance', title, description, canonical: `${SITE}${path}`, robots,
        navbar: { service: 'finance', apiBase: 'https://openvibe.network', links: [{ label: 'Money', href: '/' }, { label: 'This month', href: '/month' }] },
        footer: { service: 'finance', variant: 'full', mount: '#ov-footer' },
        head: `<link rel="stylesheet" href="${serve.url('kit.css')}"><link rel="stylesheet" href="/finance.css"><script src="/finance.js" defer></script>`,
        body: `<div id="navbar-mount"></div><main id="main" class="ovk-page fin">${body}</main>`,
    });
}

const notice = (o) => (o.error ? `<p class="fin-error" role="alert">${esc(o.error)}</p>` : '') + (o.said ? `<p class="fin-said" role="status">${esc(o.said)}</p>` : '');

function welcome() {
    return page({
        title: 'Your money, your rules, your data', robots: 'index, follow', body: `
<section class="fin-hero">
<h1>Your money, your rules, your data</h1>
<p class="fin-lede">Your accounts in one place, from a bank's CSV export or typed in, and a clear picture of each month. Free, with nothing to connect.</p>
<p><a class="fin-btn fin-btn--primary" href="/auth/login?next=%2F">Sign in to start</a></p>
</section>
<ul class="fin-promises">
<li><b>Private to you.</b> Payees and notes are stored encrypted under a key for your account alone. Nothing here enters search, analytics or AI training.</li>
<li><b>No money moves.</b> It reads and plans. It never pays, transfers or cancels anything.</li>
<li><b>Yours to take.</b> Download everything as one file, or delete everything, any time.</li>
</ul>` });
}

function home({ accounts, month, o = {} }) {
    const total = {};
    for (const a of accounts) total[a.currency] = (total[a.currency] || 0) + a.balance_cents;
    const totals = Object.entries(total).map(([c, v]) => money(v, c)).join(' · ');
    const kindChips = KINDS.map((k, i) => `<label class="fin-chip"><input type="radio" name="kind" value="${k}"${i === 0 ? ' checked' : ''}><span>${esc(KIND_WORDS[k])}</span></label>`).join('');
    return page({
        title: 'Your money', body: `
<header class="fin-head"><h1>Your money</h1>${accounts.length ? `<p class="fin-total">${esc(totals)}</p>` : ''}</header>
${notice(o)}
${accounts.length ? `<section class="fin-month-card" aria-label="${esc(monthName(month.month))}">
<a class="fin-month-link" href="/month?m=${month.month}"><span>${esc(monthName(month.month))}</span>
<span class="fin-in">In ${esc(money(month.income_cents))}</span><span class="fin-out">Out ${esc(money(month.spent_cents))}</span></a></section>
<ul class="fin-accounts">${accounts.map((a) => `<li><a class="fin-account" href="/accounts/${esc(a.id)}">
<span class="fin-account-name">${esc(a.name)}<small>${esc(KIND_WORDS[a.kind] || a.kind)} · ${a.count} transaction${a.count === 1 ? '' : 's'}</small></span>
<span class="fin-account-balance${a.balance_cents < 0 ? ' is-neg' : ''}">${esc(money(a.balance_cents, a.currency))}</span></a></li>`).join('')}</ul>`
        : `<p class="fin-empty">Start with an account: name it, then type in transactions or import your bank's CSV export.</p>`}
<details class="fin-fold"${accounts.length ? '' : ' open'}><summary>Add an account</summary>
<form class="fin-form" method="post" action="/accounts">
<label class="fin-field"><span>Name</span><input name="name" maxlength="80" required placeholder="Everyday checking" autocomplete="off"></label>
<fieldset class="fin-chips"><legend>Kind</legend>${kindChips}</fieldset>
<div class="fin-row"><label class="fin-field"><span>Currency</span><input name="currency" value="USD" maxlength="3" pattern="[A-Za-z]{3}" autocomplete="off"></label>
<label class="fin-field"><span>Balance before the first transaction</span><input name="opening" inputmode="decimal" placeholder="0.00" autocomplete="off"></label></div>
<p><button class="fin-btn fin-btn--primary" type="submit">Add the account</button></p>
</form></details>
<p class="fin-foot"><a href="/rules">Your category rules</a> · <a href="/data">Your data: download or delete everything</a></p>` });
}

function rulesPage({ rules, o = {} }) {
    return page({
        title: 'Your category rules', path: '/rules', body: `
<header class="fin-head"><p class="fin-crumb"><a href="/">Your money</a></p><h1>Your category rules</h1></header>
${notice(o)}
<p class="fin-note">A rule puts every transaction whose payee contains its words in its category: the ones nobody has categorised yet, and every import from now on. A category you set yourself stays yours. Make one by ticking <b>Always</b> when you change a transaction's category.</p>
${rules.length ? `<ul class="fin-rules">${rules.map((r) => `<li><span class="fin-rule-what"><b>${esc(r.match)}</b><span>→ ${esc(r.category)}</span></span>
<form method="post" action="/rules/${esc(r.id)}/delete"><button type="submit" class="fin-mini">Remove</button></form></li>`).join('')}</ul>`
        : '<p class="fin-empty">No rules yet.</p>'}` });
}

function accountPage({ account, balance, txns, month, o = {} }) {
    const groups = new Map();
    for (const t of txns) { const m = t.posted_on.slice(0, 7); if (!groups.has(m)) groups.set(m, []); groups.get(m).push(t); }
    const cats = `<datalist id="fin-cats">${CATEGORIES.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>`;
    const row = (t) => `<li class="fin-txn"><span class="fin-txn-date">${esc(t.posted_on.slice(5))}</span>
<span class="fin-txn-what"><b>${esc(t.payee || 'No payee')}</b>${t.memo ? `<small>${esc(t.memo)}</small>` : ''}
<form class="fin-cat" method="post" action="/transactions/${esc(t.id)}/category"><input name="category" list="fin-cats" value="${esc(t.category)}" aria-label="Category" maxlength="60">${t.payee ? `<label class="fin-always" title="Every transaction from ${esc(t.payee)} goes here, now and in future imports"><input type="checkbox" name="always" value="yes"><span>Always</span></label>` : ''}<button type="submit" class="fin-mini">Save</button></form>${t.category_from === 'rule' ? '<small class="fin-by-rule">by a rule</small>' : ''}</span>
<span class="fin-txn-amount${t.amount_cents < 0 ? ' is-neg' : ' is-pos'}">${esc(money(t.amount_cents, account.currency))}</span></li>`;
    const today = new Date().toISOString().slice(0, 10);
    return page({
        title: account.name, path: `/accounts/${account.id}`, body: `
<header class="fin-head"><p class="fin-crumb"><a href="/">Your money</a></p><h1>${esc(account.name)}</h1>
<p class="fin-total${balance < 0 ? ' is-neg' : ''}">${esc(money(balance, account.currency))}</p></header>
${notice(o)}${cats}
<div class="fin-tools">
<details class="fin-fold"><summary>Add a transaction</summary>
<form class="fin-form" method="post" action="/accounts/${esc(account.id)}/transactions">
<div class="fin-row"><label class="fin-field"><span>Date</span><input type="date" name="posted_on" value="${today}" required></label>
<label class="fin-field"><span>Amount</span><input name="amount" inputmode="decimal" required placeholder="12.34" autocomplete="off"></label></div>
<fieldset class="fin-chips"><legend>Money</legend><label class="fin-chip"><input type="radio" name="direction" value="out" checked><span>Out</span></label><label class="fin-chip"><input type="radio" name="direction" value="in"><span>In</span></label></fieldset>
<label class="fin-field"><span>Payee</span><input name="payee" maxlength="300" autocomplete="off"></label>
<label class="fin-field"><span>Category</span><input name="category" list="fin-cats" maxlength="60" autocomplete="off" placeholder="Groceries"></label>
<p><button class="fin-btn fin-btn--primary" type="submit">Add it</button></p>
</form></details>
<details class="fin-fold"><summary>Import a bank's CSV export</summary>
<form class="fin-form" method="post" action="/accounts/${esc(account.id)}/import">
<p class="fin-note">Most banks export a CSV with a date, an amount (or debit and credit) and a description. Importing the same file twice adds nothing twice.</p>
<label class="fin-file"><input type="file" accept=".csv,text/csv,text/plain" data-fin-file="csv"><span class="fin-btn">Choose a CSV file</span><span class="fin-file-name" data-fin-file-name>No file chosen yet</span></label>
<label class="fin-field"><span>Or paste it</span><textarea name="csv" rows="6" required data-fin-csv placeholder="Date,Description,Amount&#10;2026-11-02,Corner Grocer,-23.18"></textarea></label>
<p><button class="fin-btn fin-btn--primary" type="submit">Import</button></p>
</form></details>
</div>
<nav class="fin-monthnav" aria-label="Month"><a href="/accounts/${esc(account.id)}?m=${shiftMonth(month, -1)}">${esc(monthName(shiftMonth(month, -1)))}</a>
<b>${esc(monthName(month))}</b><a href="/accounts/${esc(account.id)}?m=${shiftMonth(month, 1)}">${esc(monthName(shiftMonth(month, 1)))}</a></nav>
${txns.length ? [...groups.values()].map((list) => `<ul class="fin-txns">${list.map(row).join('')}</ul>`).join('') : `<p class="fin-empty">Nothing in ${esc(monthName(month))}. Add a transaction, or import a CSV.</p>`}` });
}

function monthPage({ m, o = {} }) {
    const spent = m.by_category.filter((c) => c.out_cents > 0);
    const most = Math.max(1, ...spent.map((c) => c.out_cents));
    return page({
        title: `${monthName(m.month)}`, path: '/month', body: `
<header class="fin-head"><p class="fin-crumb"><a href="/">Your money</a></p><h1>${esc(monthName(m.month))}</h1></header>
${notice(o)}
<nav class="fin-monthnav" aria-label="Month"><a href="/month?m=${shiftMonth(m.month, -1)}">${esc(monthName(shiftMonth(m.month, -1)))}</a><b>${esc(monthName(m.month))}</b><a href="/month?m=${shiftMonth(m.month, 1)}">${esc(monthName(shiftMonth(m.month, 1)))}</a></nav>
<div class="fin-sums"><p><span>In</span><b class="fin-in">${esc(money(m.income_cents))}</b></p><p><span>Out</span><b class="fin-out">${esc(money(m.spent_cents))}</b></p>
<p><span>Left</span><b class="${m.income_cents - m.spent_cents < 0 ? 'is-neg' : ''}">${esc(money(m.income_cents - m.spent_cents))}</b></p></div>
${spent.length ? `<ul class="fin-bars">${spent.map((c) => `<li><span class="fin-bar-name">${esc(c.category)}<small>${c.count}</small></span>
<span class="fin-bar"><span style="--w:${Math.max(2, Math.round((c.out_cents / most) * 100))}%"></span></span><span class="fin-bar-sum">${esc(money(c.out_cents))}</span></li>`).join('')}</ul>`
        : '<p class="fin-empty">No spending this month.</p>'}
<p class="fin-note">Transfers between your own accounts are left out. Amounts in other currencies are added as they are.</p>` });
}

function dataPage({ o = {} }) {
    return page({
        title: 'Your data', path: '/data', body: `
<header class="fin-head"><p class="fin-crumb"><a href="/">Your money</a></p><h1>Your data</h1></header>
${notice(o)}
<section class="fin-sec"><h2>Download everything</h2><p>Every account and transaction, as one JSON file, readable anywhere.</p>
<p><a class="fin-btn" href="/data/export" download>Download</a></p></section>
<section class="fin-sec"><h2>Delete everything</h2><p>Every account, transaction and import of yours, for good. There is no undo.</p>
<form method="post" action="/data/delete" class="fin-form"><label class="fin-check"><input type="checkbox" name="sure" value="yes" required><span>Yes, delete all my finance data</span></label>
<p><button class="fin-btn fin-btn--danger" type="submit">Delete everything</button></p></form></section>` });
}

module.exports = { page, welcome, home, accountPage, monthPage, dataPage, rulesPage, money, esc, monthName };
