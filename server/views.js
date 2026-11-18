'use strict';
/**
 * Finance's pages, server-rendered in the network's shell (openvibe-shared/shell, kit.css) with this site's own
 * finance.css. Every value that reaches markup goes through esc(). Forms post to the same origin and work without
 * script; public/finance.js only reads a chosen CSV file into the paste box.
 */
const shell = require('openvibe-shared/shell');
const serve = require('openvibe-shared/serve');
const { CATEGORIES, KINDS } = require('./store');
const { payoff, faster, perMonth } = require('./plan');

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
        navbar: { service: 'finance', apiBase: 'https://openvibe.network', links: [{ label: 'Money', href: '/' }, { label: 'This month', href: '/month' }, { label: 'Recurring', href: '/bills' }, { label: 'Goals', href: '/goals' }, { label: 'What if', href: '/ahead' }] },
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
<p class="fin-lede">Your accounts in one place, from your bank's download (CSV, OFX or QFX) or typed in, and a clear picture of each month. Free, with nothing to connect.</p>
<p><a class="fin-btn fin-btn--primary" href="/auth/login?next=%2F">Sign in to start</a></p>
</section>
<ul class="fin-promises">
<li><b>Private to you.</b> Payees and notes are stored encrypted under a key for your account alone. Nothing here enters search, analytics or AI training.</li>
<li><b>No money moves.</b> It reads and plans. It never pays, transfers or cancels anything.</li>
<li><b>Yours to take.</b> Download everything as one file, or delete everything, any time.</li>
</ul>` });
}

// OpenVibe's money Experts on Actor (Actor #623): they read your numbers here through /mcp, as you, once you allow
// Actor in OpenVibe Finance on your Apps page; none moves money.
const EXPERTS = [
    { id: 'bp_budget_coach', name: 'Budget coach', what: 'A budget you can live with, from your real month.' },
    { id: 'bp_can_i_afford_it', name: 'Can I afford it?', what: 'Yes, not yet or no, for a purchase or a new monthly cost.' },
    { id: 'bp_debt_planner', name: 'Debt planner', what: 'The fastest and the cheapest way out of your loans and cards.' },
    { id: 'bp_subscription_auditor', name: 'Subscription auditor', what: 'Every recurring charge, and what dropping each saves.' },
];
const expertsSection = () => `<section class="fin-sec fin-experts" aria-labelledby="fin-experts-h"><h2 id="fin-experts-h">Ask an Expert</h2>
<ul class="fin-expert-list">${EXPERTS.map((e) => `<li><a class="fin-expert" href="https://openvibe.actor/experts/${e.id}"><b>${esc(e.name)}</b><span>${esc(e.what)}</span></a></li>`).join('')}</ul>
<p class="fin-note">They read your numbers here as you once you allow Actor in OpenVibe Finance on your <a href="https://openvibe.network/apps">Apps page</a>, and only to read: nothing here moves money.</p></section>`;

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
        : `<p class="fin-empty">Start with an account: name it, then type in transactions or import your bank's download (CSV, OFX or QFX).</p>`}
<details class="fin-fold"${accounts.length ? '' : ' open'}><summary>Add an account</summary>
<form class="fin-form" method="post" action="/accounts">
<label class="fin-field"><span>Name</span><input name="name" maxlength="80" required placeholder="Everyday checking" autocomplete="off"></label>
<fieldset class="fin-chips"><legend>Kind</legend>${kindChips}</fieldset>
<div class="fin-row"><label class="fin-field"><span>Currency</span><input name="currency" value="USD" maxlength="3" pattern="[A-Za-z]{3}" autocomplete="off"></label>
<label class="fin-field"><span>Balance before the first transaction</span><input name="opening" inputmode="decimal" placeholder="0.00" autocomplete="off"></label></div>
<p><button class="fin-btn fin-btn--primary" type="submit">Add the account</button></p>
</form></details>
${accounts.length ? expertsSection() : ''}
<p class="fin-foot"><a href="/ahead">Net worth and what if</a> · <a href="/goals">Goals and debt</a> · <a href="/bills">Recurring bills</a> · <a href="/rules">Your category rules</a> · <a href="/data">Your data: download or delete everything</a></p>` });
}

const CADENCE_WORDS = { weekly: 'Every week', 'every two weeks': 'Every two weeks', monthly: 'Every month', quarterly: 'Every three months', yearly: 'Every year' };
const dayName = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function billsPage({ found, today, o = {} }) {
    const out = found.filter((r) => r.direction === 'out');
    const income = found.filter((r) => r.direction === 'in');
    const monthly = out.reduce((n, r) => n + r.monthly_cents, 0);
    const soon = out.filter((r) => !r.overdue && r.next_on >= today && Date.parse(r.next_on) - Date.parse(today) <= 31 * 86400000);
    const row = (r) => `<li class="fin-bill${r.overdue ? ' is-late' : ''}"><span class="fin-bill-what"><b>${esc(r.payee)}</b>
<span>${esc(CADENCE_WORDS[r.cadence] || r.cadence)} · seen ${r.count} times · last ${esc(dayName(r.last_on))}</span></span>
<span class="fin-bill-when">${r.overdue ? `<small>Expected ${esc(dayName(r.next_on))}: not seen</small>` : `<small>Next ${esc(dayName(r.next_on))}</small>`}<b>${esc(money(r.typical_cents))}</b></span></li>`;
    return page({
        title: 'Recurring', path: '/bills', body: `
<header class="fin-head"><p class="fin-crumb"><a href="/">Your money</a></p><h1>Recurring</h1>
${out.length ? `<p class="fin-total">About ${esc(money(monthly))} a month</p>` : ''}</header>
${notice(o)}
<p class="fin-note">Found in your own transactions: the same payee and a similar amount, at a steady rhythm, at least three times. Nothing here is stored or sent anywhere.</p>
${soon.length ? `<section class="fin-sec"><h2>The next 31 days</h2><ul class="fin-bills">${soon.map(row).join('')}</ul></section>` : ''}
<section class="fin-sec"><h2>Bills and subscriptions</h2>${out.length ? `<ul class="fin-bills">${out.map(row).join('')}</ul>` : '<p class="fin-empty">None found yet. A few months of transactions show them.</p>'}</section>
${income.length ? `<section class="fin-sec"><h2>Money that comes in regularly</h2><ul class="fin-bills">${income.map(row).join('')}</ul></section>` : ''}` });
}

const monthsWords = (n) => (n < 12 ? `${n} month${n === 1 ? '' : 's'}` : `${Math.floor(n / 12)} year${n >= 24 ? 's' : ''}${n % 12 ? ` ${n % 12} month${n % 12 === 1 ? '' : 's'}` : ''}`);
const pct = (bps) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

function goalsPage({ goals, accounts, today, o = {} }) {
    const debts = accounts.filter((a) => (a.kind === 'loan' || a.kind === 'credit'));
    const savings = accounts.filter((a) => a.kind !== 'loan' && a.kind !== 'credit');
    const goalRow = (g) => {
        const have = Math.max(0, g.have_cents);
        const done = have >= g.target_cents;
        const need = perMonth({ target_cents: g.target_cents, have_cents: have, target_on: g.target_on, today });
        const tracked = g.account_id ? accounts.find((a) => a.id === g.account_id) : null;
        return `<li class="fin-goal${done ? ' is-done' : ''}"><div class="fin-goal-top"><b>${esc(g.name)}</b><span>${esc(money(have))} of ${esc(money(g.target_cents))}</span></div>
<span class="fin-bar fin-bar--budget"><span style="--w:${Math.min(100, Math.round((have / g.target_cents) * 100))}%"></span></span>
<p class="fin-goal-note">${done ? 'Reached.' : need ? `${esc(money(need))} a month reaches it by ${esc(monthName(g.target_on.slice(0, 7)))}.` : g.target_on ? `The date (${esc(monthName(g.target_on.slice(0, 7)))}) has passed.` : 'No date: it is there when it is there.'}
${tracked ? ` Tracks <a href="/accounts/${esc(tracked.id)}">${esc(tracked.name)}</a>.` : ''}</p>
<div class="fin-goal-tools">${tracked ? '' : `<form method="post" action="/goals/${esc(g.id)}/saved" class="fin-cat"><label class="fin-saved"><span>Saved</span><input name="saved" inputmode="decimal" value="${(g.saved_cents / 100).toFixed(2)}" autocomplete="off"></label><button type="submit" class="fin-mini">Update</button></form>`}
<form method="post" action="/goals/${esc(g.id)}/delete" class="fin-goal-remove"><button type="submit" class="fin-mini fin-mini--quiet">Remove</button></form></div></li>`;
    };
    const debtRow = (a) => {
        const owed = Math.max(0, -a.balance_cents);
        const terms = a.apr_bps != null && a.payment_cents;
        let said = 'Add its yearly rate and your monthly payment to see when it is paid off.';
        let tip = '';
        if (!owed) said = 'Nothing owed.';
        else if (terms) {
            const p = payoff({ owed_cents: owed, apr_bps: a.apr_bps, payment_cents: a.payment_cents });
            if (p.never) said = `At ${esc(money(a.payment_cents))} a month it never gets paid off: that does not cover the ${esc(pct(a.apr_bps))} interest.`;
            else {
                const extra = Math.max(2500, Math.round(a.payment_cents * 0.25 / 500) * 500);
                const f = faster({ owed_cents: owed, apr_bps: a.apr_bps, payment_cents: a.payment_cents }, extra);
                said = `Paid off in <b>${esc(monthsWords(p.months))}</b> at ${esc(money(a.payment_cents))} a month, ${esc(money(p.interest_cents))} of it interest (${esc(pct(a.apr_bps))} a year).`;
                if (f && f.months_sooner) tip = `${esc(money(extra))} more a month: ${esc(monthsWords(f.months_sooner))} sooner and ${esc(money(f.interest_saved_cents))} less interest.`;
            }
        }
        return `<li class="fin-goal"><div class="fin-goal-top"><b><a href="/accounts/${esc(a.id)}">${esc(a.name)}</a></b><span>${esc(money(owed, a.currency))} owed</span></div>
<p class="fin-goal-note">${said}</p>${tip ? `<p class="fin-goal-tip">${tip}</p>` : ''}
${terms ? '<details class="fin-fold fin-fold--quiet"><summary>Change the rate or payment</summary>' : ''}<form class="fin-row fin-debt" method="post" action="/accounts/${esc(a.id)}/debt">
<label class="fin-field"><span>Yearly rate (%)</span><input name="apr" inputmode="decimal" value="${a.apr_bps != null ? (a.apr_bps / 100).toFixed(2) : ''}" placeholder="24.99" autocomplete="off"></label>
<label class="fin-field"><span>Monthly payment</span><input name="payment" inputmode="decimal" value="${a.payment_cents ? (a.payment_cents / 100).toFixed(2) : ''}" placeholder="150.00" autocomplete="off"></label>
<p><button class="fin-btn" type="submit">Save</button></p></form>${terms ? '</details>' : ''}</li>`;
    };
    const accountChips = savings.map((a) => `<label class="fin-chip"><input type="radio" name="account" value="${esc(a.id)}"><span>${esc(a.name)}</span></label>`).join('');
    return page({
        title: 'Goals and debt', path: '/goals', body: `
<header class="fin-head"><p class="fin-crumb"><a href="/">Your money</a></p><h1>Goals and debt</h1></header>
${notice(o)}
<section class="fin-sec"><h2>Goals</h2>${goals.length ? `<ul class="fin-goals">${goals.map(goalRow).join('')}</ul>` : '<p class="fin-empty">No goals yet: an emergency fund, a trip, a deposit.</p>'}
<details class="fin-fold"><summary>Add a goal</summary>
<form class="fin-form" method="post" action="/goals">
<label class="fin-field"><span>Name</span><input name="name" maxlength="80" required placeholder="Emergency fund" autocomplete="off"></label>
<div class="fin-row"><label class="fin-field"><span>Amount</span><input name="target" inputmode="decimal" required placeholder="5000" autocomplete="off"></label>
<label class="fin-field"><span>By (optional)</span><input type="date" name="target_on"></label></div>
${savings.length ? `<fieldset class="fin-chips"><legend>Its progress is (optional)</legend><label class="fin-chip"><input type="radio" name="account" value="" checked><span>What I enter</span></label>${accountChips}</fieldset>` : ''}
<p><button class="fin-btn fin-btn--primary" type="submit">Add the goal</button></p>
</form></details></section>
<section class="fin-sec"><h2>Debt</h2>${debts.length ? `<ul class="fin-goals">${debts.map(debtRow).join('')}</ul>` : '<p class="fin-empty">No loans or credit cards. Add one as an account (its kind: Loan or Credit card) to plan paying it off.</p>'}</section>` });
}

const shortMonth = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** A small line chart in the page's own colours: lines [{ cls, points: [cents] }], the zero line when it is crossed. */
function lineChart(lines, { label, area = false }) {
    const all = lines.flatMap((l) => l.points);
    let lo = Math.min(...all), hi = Math.max(...all);
    if (lo === hi) { lo -= 10000; hi += 10000; }
    const pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    const W = 600, H = 160, n = lines[0].points.length;
    const x = (i) => (n === 1 ? W / 2 : (i / (n - 1)) * W).toFixed(1);
    const y = (c) => (H - ((c - lo) / (hi - lo)) * H).toFixed(1);
    const d = (pts) => pts.map((c, i) => `${i ? 'L' : 'M'}${x(i)},${y(c)}`).join('');
    const zero = lo < 0 && hi > 0 ? `<line class="fin-zero" x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}"/>` : '';
    const fill = area ? `<path class="fin-area" d="${d(lines[0].points)}L${W},${H}L0,${H}Z"/>` : '';
    return `<svg class="fin-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">${fill}${zero}${lines.map((l) => `<path class="${l.cls}" d="${d(l.points)}"/>`).join('')}</svg>`;
}

function aheadPage({ net_worth, average, spendable_cents, goals_need_cents, has_accounts, asked, ask, error, plan, q = {} }) {
    const last = net_worth[net_worth.length - 1];
    const first = net_worth.find((p) => p.assets_cents || p.owed_cents) || net_worth[0];
    const change = last.net_cents - first.net_cents;
    const worth = !has_accounts ? '<p class="fin-empty">Add an account on <a href="/">Your money</a> to see your net worth.</p>' : `
<p class="fin-big${last.net_cents < 0 ? ' is-neg' : ''}">${esc(money(last.net_cents))}</p>
<p class="fin-sub">${esc(money(last.assets_cents))} in your accounts · ${esc(money(last.owed_cents))} owed${first.month !== last.month ? ` · <span class="${change < 0 ? 'is-neg' : 'fin-in'}">${change < 0 ? '−' : '+'}${esc(money(Math.abs(change)))}</span> since ${esc(monthName(first.month))}` : ''}</p>
${net_worth.length > 1 ? `${lineChart([{ cls: 'fin-line', points: net_worth.map((p) => p.net_cents) }], { label: `Net worth at the end of each month, ${monthName(net_worth[0].month)} to ${monthName(last.month)}`, area: true })}
<div class="fin-axis"><span>${esc(shortMonth(net_worth[0].month))}</span><span>Now</span></div>` : ''}`;

    const val = (k) => esc(q[k] || '');
    const months = plan ? plan.now.map((p) => p.month) : [];
    // When: a row of month chips (the first, "next month", by default), never the browser's month box.
    const whenChips = (name, legend) => `<div class="fin-when"><span class="fin-when-label" id="fin-when-${name}">${legend}</span><div class="fin-chips fin-chips--scroll" role="radiogroup" aria-labelledby="fin-when-${name}">${months.map((mm, i) => {
        const on = (q[name] || months[0]) === mm;
        const label = i === 0 ? 'Next month' : mm.endsWith('-01') || i === 1 ? shortMonth(mm) : new Date(`${mm}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
        return `<label class="fin-chip"><input type="radio" name="${name}" value="${i === 0 ? '' : mm}"${on ? ' checked' : ''}><span>${esc(label)}</span></label>`;
    }).join('')}</div></div>`;
    const dirIn = q.dir === 'in';
    const form = `<form class="fin-form fin-ask" method="get" action="/ahead">
<fieldset class="fin-askset"><legend>Can I afford it? A one-off cost</legend>
<label class="fin-field"><span>Amount</span><input name="cost" inputmode="decimal" placeholder="1,200.00" value="${val('cost')}" autocomplete="off"></label>
${whenChips('cost_on', 'Paid in')}</fieldset>
<fieldset class="fin-askset"><legend>What if something changes every month</legend>
<div class="fin-chips"><label class="fin-chip"><input type="radio" name="dir" value="out"${dirIn ? '' : ' checked'}><span>More going out</span></label><label class="fin-chip"><input type="radio" name="dir" value="in"${dirIn ? ' checked' : ''}><span>More coming in</span></label></div>
<label class="fin-field"><span>Amount a month</span><input name="change" inputmode="decimal" placeholder="200.00" value="${val('change')}" autocomplete="off"></label>
${whenChips('from', 'From')}</fieldset>
<p class="fin-ask-go"><button class="fin-btn fin-btn--primary" type="submit">See what happens</button>${asked ? '<a class="fin-btn" href="/ahead">Start over</a>' : ''}</p>
</form>`;

    let result = '';
    if (plan) {
        const end = plan.with[plan.with.length - 1];
        let verdict;
        if (plan.now_below_zero_on) verdict = `<p class="fin-verdict is-no">Your average month spends more than comes in: at this rate the money to spend runs out in ${esc(monthName(plan.now_below_zero_on))}.</p>`;
        else if (!asked) verdict = `<p class="fin-verdict">At your average month you have about <b>${esc(money(end.cents))}</b> to spend in ${esc(monthName(end.month))}.</p>`;
        else if (plan.below_zero_on) verdict = `<p class="fin-verdict is-no">Not yet: it takes you below zero in ${esc(monthName(plan.below_zero_on))} (lowest ${esc(money(plan.lowest.cents))}).${plan.afford_by ? ` At your average month you could pay it in <b>${esc(monthName(plan.afford_by))}</b> and stay above zero.` : ''}</p>`;
        else verdict = `<p class="fin-verdict is-yes">Yes. The lowest it gets is <b>${esc(money(plan.lowest.cents))}</b>, in ${esc(monthName(plan.lowest.month))}; about ${esc(money(end.cents))} in ${esc(monthName(end.month))}.</p>`;
        const changeLine = asked && ask.change_cents ? `<p class="fin-sub">Left over each month: ${esc(money(plan.left_now_cents))} now, <b>${esc(money(plan.left_with_cents))}</b> with the change.</p>` : '';
        const goalsLine = goals_need_cents ? `<p class="fin-sub">Your goals with dates need ${esc(money(goals_need_cents))} a month${plan.left_with_cents < goals_need_cents ? `: ${asked ? 'this leaves' : 'your average month leaves'} less than that (<a href="/goals">Goals</a>).` : '.'}</p>` : '';
        const lines = asked ? [{ cls: 'fin-line fin-line--now', points: [spendable_cents, ...plan.now.map((p) => p.cents)] }, { cls: 'fin-line', points: [spendable_cents, ...plan.with.map((p) => p.cents)] }]
            : [{ cls: 'fin-line', points: [spendable_cents, ...plan.now.map((p) => p.cents)] }];
        result = `<div class="fin-result" aria-live="polite">${verdict}${changeLine}${goalsLine}
${lineChart(lines, { label: `Money to spend at the end of each month, now to ${monthName(end.month)}` })}
<div class="fin-axis"><span>Now</span><span>${esc(shortMonth(end.month))}</span></div>
${asked ? '<p class="fin-legend"><span class="fin-key fin-key--now">As things are</span><span class="fin-key">With the change</span></p>' : ''}
<details class="fin-fold fin-fold--quiet"><summary>Month by month</summary><div class="fin-table-wrap"><table class="fin-table"><thead><tr><th>End of</th><th>${asked ? 'As things are' : 'To spend'}</th>${asked ? '<th>With the change</th>' : ''}</tr></thead><tbody>
${plan.now.map((p, i) => `<tr><td>${esc(shortMonth(p.month))}</td><td class="${p.cents < 0 ? 'is-neg' : ''}">${esc(money(p.cents))}</td>${asked ? `<td class="${plan.with[i].cents < 0 ? 'is-neg' : ''}">${esc(money(plan.with[i].cents))}</td>` : ''}</tr>`).join('')}
</tbody></table></div></details></div>`;
    }
    const base = average.months.length ? `<p class="fin-sub">Your average month (${esc(average.months.length === 1 ? monthName(average.months[0]) : `${shortMonth(average.months[0])} to ${shortMonth(average.months[average.months.length - 1])}`)}): ${esc(money(average.income_cents))} in, ${esc(money(average.spending_cents))} out, <b>${esc(money(average.income_cents - average.spending_cents))}</b> left over. ${esc(money(spendable_cents))} to spend now.</p>`
        : '<p class="fin-empty">A month or two of transactions (the months before this one) shows what is ahead.</p>';
    return page({
        title: 'Net worth and what if', path: '/ahead', body: `
<header class="fin-head"><p class="fin-crumb"><a href="/">Your money</a></p><h1>Net worth and what if</h1></header>
<section class="fin-sec"><h2>Net worth</h2>${worth}</section>
<section class="fin-sec"><h2>What if</h2>${base}
${error ? `<p class="fin-error" role="alert">${esc(error)}</p>` : ''}${result}${average.months.length ? form : ''}</section>
<p class="fin-note">Roughly: your average month of the last three, repeated from next month. Money to spend is checking, savings and cash, less what cards owe; investments and loans are left out, as are transfers between your accounts. Nothing here moves money.</p>` });
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
<form class="fin-cat" method="post" action="/transactions/${esc(t.id)}/category">${t.category_from === 'ai' ? '<span class="fin-by-agent" title="An agent you allowed set this category. Change it and it is yours.">agent</span>' : ''}<input name="category" list="fin-cats" value="${esc(t.category)}" aria-label="Category" maxlength="60">${t.payee ? `<label class="fin-always" title="Every transaction from ${esc(t.payee)} goes here, now and in future imports"><input type="checkbox" name="always" value="yes"><span>Always</span></label>` : ''}<button type="submit" class="fin-mini">Save</button></form>${t.category_from === 'rule' ? '<small class="fin-by-rule">by a rule</small>' : ''}</span>
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
<details class="fin-fold"><summary>Import a bank's export (CSV, OFX or QFX)</summary>
<form class="fin-form" method="post" action="/accounts/${esc(account.id)}/import">
<p class="fin-note">Banks offer a download as CSV, OFX or QFX (Quicken). Any of them works; importing the same file twice adds nothing twice.</p>
<label class="fin-file"><input type="file" accept=".csv,.ofx,.qfx,text/csv,text/plain,application/x-ofx" data-fin-file="csv"><span class="fin-btn">Choose a file</span><span class="fin-file-name" data-fin-file-name>No file chosen yet</span></label>
<label class="fin-field"><span>Or paste it</span><textarea name="csv" rows="6" required data-fin-csv placeholder="Date,Description,Amount&#10;2026-11-02,Corner Grocer,-23.18"></textarea></label>
<p><button class="fin-btn fin-btn--primary" type="submit">Import</button></p>
</form></details>
</div>
<nav class="fin-monthnav" aria-label="Month"><a href="/accounts/${esc(account.id)}?m=${shiftMonth(month, -1)}">${esc(monthName(shiftMonth(month, -1)))}</a>
<b>${esc(monthName(month))}</b><a href="/accounts/${esc(account.id)}?m=${shiftMonth(month, 1)}">${esc(monthName(shiftMonth(month, 1)))}</a></nav>
${txns.length ? [...groups.values()].map((list) => `<ul class="fin-txns">${list.map(row).join('')}</ul>`).join('') : `<p class="fin-empty">Nothing in ${esc(monthName(month))}. Add a transaction, or import your bank's export.</p>`}` });
}

function monthPage({ m, budgets = [], o = {} }) {
    const limit = new Map(budgets.map((b) => [b.category, b.monthly_cents]));
    const spentBy = new Map(m.by_category.filter((c) => c.out_cents > 0).map((c) => [c.category, c]));
    // Budgeted categories with nothing spent yet still show: what is left is the whole budget.
    for (const b of budgets) if (!spentBy.has(b.category)) spentBy.set(b.category, { category: b.category, out_cents: 0, count: 0 });
    const spent = [...spentBy.values()].sort((a, b) => b.out_cents - a.out_cents);
    // Budgets read against their own limit (a full bar is the budget, red once over); the rest against the largest.
    const withBudget = spent.filter((c) => limit.has(c.category));
    const without = spent.filter((c) => !limit.has(c.category));
    const most = Math.max(1, ...without.map((c) => c.out_cents));
    const budgeted = budgets.reduce((n, b) => n + b.monthly_cents, 0);
    // What the budgeted categories really spent (an overspend is counted, not capped at its budget).
    const usedOfBudgets = withBudget.reduce((n, c) => n + c.out_cents, 0);
    const cats = `<datalist id="fin-cats">${CATEGORIES.filter((c) => !['Income', 'Transfers', 'Uncategorized'].includes(c)).map((c) => `<option value="${esc(c)}">`).join('')}</datalist>`;
    const budgetBar = (c) => {
        const cap = limit.get(c.category);
        const over = c.out_cents > cap;
        const left = cap - c.out_cents;
        return `<li class="${over ? 'is-over' : ''}"><span class="fin-bar-name">${esc(c.category)}<small>${c.count}</small></span>
<span class="fin-bar fin-bar--budget"><span style="--w:${Math.min(100, Math.round((c.out_cents / cap) * 100))}%"></span></span>
<span class="fin-bar-sum">${esc(money(c.out_cents))}<small class="${over ? 'is-neg' : ''}">of ${esc(money(cap))} · ${over ? `${esc(money(-left))} over` : `${esc(money(left))} left`}</small></span></li>`;
    };
    const bar = (c) => `<li><span class="fin-bar-name">${esc(c.category)}<small>${c.count}</small></span>
<span class="fin-bar"><span style="--w:${Math.max(2, Math.round((c.out_cents / most) * 100))}%"></span></span><span class="fin-bar-sum">${esc(money(c.out_cents))}</span></li>`;
    return page({
        title: `${monthName(m.month)}`, path: '/month', body: `
<header class="fin-head"><p class="fin-crumb"><a href="/">Your money</a></p><h1>${esc(monthName(m.month))}</h1></header>
${notice(o)}
<nav class="fin-monthnav" aria-label="Month"><a href="/month?m=${shiftMonth(m.month, -1)}">${esc(monthName(shiftMonth(m.month, -1)))}</a><b>${esc(monthName(m.month))}</b><a href="/month?m=${shiftMonth(m.month, 1)}">${esc(monthName(shiftMonth(m.month, 1)))}</a></nav>
<div class="fin-sums"><p><span>In</span><b class="fin-in">${esc(money(m.income_cents))}</b></p><p><span>Out</span><b class="fin-out">${esc(money(m.spent_cents))}</b></p>
<p><span>Left</span><b class="${m.income_cents - m.spent_cents < 0 ? 'is-neg' : ''}">${esc(money(m.income_cents - m.spent_cents))}</b></p></div>
${withBudget.length ? `<section class="fin-sec"><h2>Budgets</h2><p class="fin-budget-sum">${esc(money(usedOfBudgets))} of ${esc(money(budgeted))} spent</p>
<ul class="fin-bars">${withBudget.map(budgetBar).join('')}</ul></section>` : ''}
${without.length ? `<section class="fin-sec">${withBudget.length ? '<h2>Everything else</h2>' : ''}<ul class="fin-bars">${without.map(bar).join('')}</ul></section>` : (withBudget.length ? '' : '<p class="fin-empty">No spending this month.</p>')}
<details class="fin-fold"><summary>${budgets.length ? 'Change a budget' : 'Set a monthly budget for a category'}</summary>
<form class="fin-form" method="post" action="/budgets">${cats}
<div class="fin-row"><label class="fin-field"><span>Category</span><input name="category" list="fin-cats" required maxlength="60" placeholder="Eating out" autocomplete="off"></label>
<label class="fin-field"><span>A month</span><input name="amount" inputmode="decimal" placeholder="300.00 (empty removes it)" autocomplete="off"></label></div>
<input type="hidden" name="back" value="${esc(m.month)}">
<p><button class="fin-btn fin-btn--primary" type="submit">Save the budget</button></p>
</form></details>
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

module.exports = { page, welcome, home, accountPage, monthPage, dataPage, rulesPage, billsPage, goalsPage, aheadPage, lineChart, money, esc, monthName };
