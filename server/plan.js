'use strict';
/**
 * The arithmetic of goals and debt (plan §L.2), on whole cents, with no rounding drift that matters to a person.
 *
 *   payoff({ owed_cents, apr_bps, payment_cents })  → { months, interest_cents, never }   (never: the payment does not
 *                                                     cover the interest, so the balance never falls)
 *   faster({ owed_cents, apr_bps, payment_cents }, extra_cents) → { months_sooner, interest_saved_cents }
 *   perMonth({ target_cents, have_cents, target_on, today }) → cents a month to reach it by then (0 when reached,
 *                                                     null without a date or when the date has passed)
 */

function payoff({ owed_cents, apr_bps = 0, payment_cents }) {
    let owed = Math.max(0, Math.round(owed_cents));
    if (!owed) return { months: 0, interest_cents: 0, never: false };
    if (!payment_cents || payment_cents <= 0) return { months: null, interest_cents: null, never: true };
    const rate = Math.max(0, apr_bps) / 10000 / 12;
    let months = 0, interest = 0;
    while (owed > 0 && months < 1200) {
        const charge = Math.round(owed * rate);
        if (payment_cents <= charge) return { months: null, interest_cents: null, never: true };
        interest += charge;
        owed = owed + charge - payment_cents;
        months++;
    }
    return months >= 1200 ? { months: null, interest_cents: null, never: true } : { months, interest_cents: interest, never: false };
}

function faster(debt, extra_cents) {
    const now = payoff(debt);
    const more = payoff({ ...debt, payment_cents: (debt.payment_cents || 0) + extra_cents });
    if (more.never) return null;
    if (now.never) return { months_sooner: null, interest_saved_cents: null, months: more.months };
    return { months_sooner: now.months - more.months, interest_saved_cents: now.interest_cents - more.interest_cents, months: more.months };
}

function perMonth({ target_cents, have_cents, target_on, today = new Date().toISOString().slice(0, 10) }) {
    const left = target_cents - Math.max(0, have_cents);
    if (left <= 0) return 0;
    if (!target_on) return null;
    const [ty, tm] = target_on.split('-').map(Number);
    const [ny, nm] = today.split('-').map(Number);
    const months = (ty - ny) * 12 + (tm - nm);
    if (months <= 0) return null;
    return Math.ceil(left / months);
}

module.exports = { payoff, faster, perMonth };
