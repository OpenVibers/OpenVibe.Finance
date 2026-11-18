# OpenVibe.Finance

**Your money, your rules, your data** — [openvibe.finance](https://openvibe.finance), part of the OpenVibe network.

Your accounts in one place, from a bank's CSV export or typed in, and a clear picture of each month. Free, with nothing
to connect.

- **Private to you.** Payees and notes are stored encrypted under a key derived for your account alone
  (`server/crypto.js`). Nothing here enters search, analytics or AI training.
- **No money moves.** It reads and plans; it never pays, transfers or cancels anything.
- **Yours to take.** Download everything as one JSON file, or delete everything, at `/data`.

## What it does today (v0.4)

- Accounts (checking, savings, credit card, cash, loan, investments) with an opening balance and a running balance.
- Transactions typed in, or imported from a bank's CSV export: the columns are read from the header (date; amount, or
  debit and credit; payee or description; memo; category), with the date and amount shapes banks send. Importing the
  same file twice adds nothing twice.
- Categories, corrected per transaction (each correction is a new revision; the category says where it came from).
- Category rules: tick **Always** on a transaction's category and every transaction whose payee contains its words
  goes there, past and future imports (never one you categorised yourself). `/rules` lists and removes them.
- The month: money in, money out, and spending by category (transfers between your accounts left out).
- Budgets: a monthly limit per category of spending; the month shows each against its limit (left, or over) and the
  rest of the spending beside them.
- Recurring: bills, subscriptions and regular income found in your own transactions (the same payee and a similar
  amount at a steady rhythm, three times or more): what each costs a month, when the next is due, and which stopped.
- A JSON API for all of it (`/api/v1/…`), for the person signed in.

Plan: `OpenVibe_Plan_2026-11-13.md` §L.2. Next: goals, OFX/QFX, the Link plugin
for local-only import, and Finance Experts (Budget Coach, Subscription Auditor) with narrow read permission.

## Running

```bash
npm install
npm test                                   # PGlite, a real PostgreSQL in-process
node test/harness/serve-sample.js 18471    # a local look with sample data and a stand-in sign-in
```

Production: `/opt/openvibe.finance`, unit `openvibe-finance.service` (port 5292), env `/etc/openvibe/finance.env`
(`.env.example`), nginx `deploy/nginx/openvibe.finance.conf`. Sign-in is OpenVibe.Network's OAuth client `finance`.

License: AGPL-3.0-only.
