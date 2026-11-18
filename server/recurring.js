'use strict';
/**
 * Recurring payments and income, found in a person's own transactions (plan §L.2: "recurring detection and the bill
 * calendar"). Nothing is stored: it is worked out from the rows each time, in memory, for their owner.
 *
 *   findRecurring(transactions, { today }) → [{ key, payee, direction, cadence, every_days, typical_cents, count,
 *                                             last_on, next_on, monthly_cents, overdue }]
 *
 * A series is one payee (its words, with reference numbers dropped: store.matchable) going the same way (in or out),
 * seen at least three times, its amounts within 20% of their median and its gaps steady around a week, two weeks,
 * a month, a quarter or a year. The next date is the last one plus the usual gap; a series whose next date is more than
 * half a gap behind is "overdue" (maybe cancelled, maybe late).
 */
const { matchable } = require('./store');

const CADENCES = [
    { name: 'weekly', days: 7, tolerance: 2 },
    { name: 'every two weeks', days: 14, tolerance: 3 },
    { name: 'monthly', days: 30.4, tolerance: 5 },
    { name: 'quarterly', days: 91, tolerance: 12 },
    { name: 'yearly', days: 365, tolerance: 20 },
];
const DAY_MS = 86400000;
const dayNum = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
const isoOf = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function findRecurring(transactions, { today = new Date().toISOString().slice(0, 10) } = {}) {
    const groups = new Map();
    for (const t of transactions) {
        const words = matchable(t.payee);
        if (!words || !t.amount_cents) continue;
        const key = `${t.amount_cents < 0 ? 'out' : 'in'}|${words}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(t);
    }
    const now = dayNum(today);
    const out = [];
    for (const [key, list] of groups) {
        if (list.length < 3) continue;
        const rows = [...list].sort((a, b) => a.posted_on.localeCompare(b.posted_on));
        const amounts = rows.map((r) => Math.abs(r.amount_cents));
        const typical = median(amounts);
        // Amounts that wander more than 20% from the usual one are not a bill (a grocery store is not a subscription).
        const steady = rows.filter((r) => Math.abs(Math.abs(r.amount_cents) - typical) <= typical * 0.2);
        if (steady.length < 3) continue;
        const days = [...new Set(steady.map((r) => dayNum(r.posted_on)))];
        if (days.length < 3) continue;
        const gaps = days.slice(1).map((d, i) => d - days[i]);
        const gap = median(gaps);
        const cadence = CADENCES.find((c) => Math.abs(gap - c.days) <= c.tolerance);
        if (!cadence) continue;
        // Most gaps must fit the cadence: a payee seen three times in a month and then twice a year later is not monthly.
        const fit = gaps.filter((g) => Math.abs(g - cadence.days) <= cadence.tolerance * 1.5).length;
        if (fit < Math.ceil(gaps.length * 0.6)) continue;
        const last = days[days.length - 1];
        const every = Math.round(cadence.days);
        const next = last + every;
        const latest = steady[steady.length - 1];
        out.push({
            key, payee: latest.payee, direction: key.startsWith('out') ? 'out' : 'in', cadence: cadence.name, every_days: every,
            typical_cents: Math.round(typical), count: steady.length, last_on: isoOf(last), next_on: isoOf(next),
            monthly_cents: Math.round(typical * (30.4 / cadence.days)), overdue: now - next > every / 2,
            category: latest.category,
        });
    }
    return out.sort((a, b) => a.next_on.localeCompare(b.next_on) || b.typical_cents - a.typical_cents);
}

module.exports = { findRecurring, CADENCES };
