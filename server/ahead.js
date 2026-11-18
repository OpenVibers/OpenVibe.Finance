'use strict';
/**
 * Net worth over time and what lies ahead (plan §L.2: "net worth … scenarios ('can I afford this?', 'what if rent
 * rises?')"). Pure arithmetic on whole cents: the store gathers the numbers, the page and the API show them.
 *
 *   history({ accounts: [{ id, opening_cents }], moves: [{ account_id, month, cents }], months })
 *       → [{ month, assets_cents, owed_cents, net_cents }] at each month's end (a negative balance is owed)
 *   averageMonth(monthResults) → { income_cents, spending_cents, months } over the months that had any transactions
 *   whatIf({ start_cents, income_cents, spending_cents, months, cost_cents, cost_on, change_cents, change_from })
 *       → { now, with, lowest, below_zero_on, now_below_zero_on, left_now_cents, left_with_cents, afford_by }
 *     The average month repeated from next month: `now` without the change, `with` it. A one-off cost lands in its
 *     month; a monthly change (signed: more coming in is positive) applies from its month on. afford_by: for a cost
 *     that would go below zero, the first month it could be paid without going below zero, at the average month.
 */

function history({ accounts, moves, months }) {
    const bal = new Map(accounts.map((a) => [a.id, Number(a.opening_cents) || 0]));
    const sorted = moves.slice().sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
    const out = [];
    let i = 0;
    for (const m of months) {
        while (i < sorted.length && sorted[i].month <= m) {
            if (bal.has(sorted[i].account_id)) bal.set(sorted[i].account_id, bal.get(sorted[i].account_id) + Number(sorted[i].cents));
            i++;
        }
        let assets = 0, owed = 0;
        for (const b of bal.values()) { if (b >= 0) assets += b; else owed -= b; }
        out.push({ month: m, assets_cents: assets, owed_cents: owed, net_cents: assets - owed });
    }
    return out;
}

function averageMonth(results) {
    const used = results.filter((r) => r.income_cents || r.spent_cents);
    if (!used.length) return { income_cents: 0, spending_cents: 0, months: [] };
    const sum = (k) => used.reduce((n, r) => n + r[k], 0);
    return { income_cents: Math.round(sum('income_cents') / used.length), spending_cents: Math.round(sum('spent_cents') / used.length), months: used.map((r) => r.month) };
}

function whatIf({ start_cents, income_cents, spending_cents, months, cost_cents = 0, cost_on = null, change_cents = 0, change_from = null }) {
    const net = income_cents - spending_cents;
    const costAt = cost_cents ? Math.max(0, cost_on ? months.indexOf(cost_on) : 0) : -1;
    const fromAt = change_cents ? Math.max(0, change_from ? months.indexOf(change_from) : 0) : -1;
    let a = start_cents, b = start_cents;
    const now = [], withIt = [];
    months.forEach((m, i) => {
        a += net;
        b += net;
        if (i === costAt) b -= cost_cents;
        if (fromAt >= 0 && i >= fromAt) b += change_cents;
        now.push({ month: m, cents: a });
        withIt.push({ month: m, cents: b });
    });
    const lowest = withIt.reduce((lo, p) => (p.cents < lo.cents ? p : lo), withIt[0]);
    const firstBelow = (list) => (list.find((p) => p.cents < 0) || { month: null }).month;
    let affordBy = null;
    if (cost_cents && !change_cents && firstBelow(withIt) && !firstBelow(now) && net > 0) {
        // The first month k where paying it then leaves every month from k on at zero or more (net > 0: from k is enough).
        const k = months.findIndex((_m, i) => start_cents + (i + 1) * net - cost_cents >= 0);
        affordBy = k >= 0 ? months[k] : null;
    }
    return {
        now, with: withIt, lowest, below_zero_on: firstBelow(withIt), now_below_zero_on: firstBelow(now),
        left_now_cents: net, left_with_cents: net + (change_cents || 0), afford_by: affordBy,
    };
}

module.exports = { history, averageMonth, whatIf };
