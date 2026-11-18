# OpenVibe.Finance

**Your money, your rules, your data** — [openvibe.finance](https://openvibe.finance), part of the OpenVibe network.

Your accounts in one place, from a bank's CSV export or typed in, and a clear picture of each month. Free, with nothing
to connect.

- **Private to you.** Payees and notes are stored encrypted under a key derived for your account alone
  (`server/crypto.js`). Nothing here enters search, analytics or AI training.
- **No money moves.** It reads and plans; it never pays, transfers or cancels anything.
- **Yours to take.** Download everything as one JSON file, or delete everything, at `/data`.

## What it does today (v0.1)

- Accounts (checking, savings, credit card, cash, loan, investments) with an opening balance and a running balance.
- Transactions typed in, or imported from a bank's CSV export: the columns are read from the header (date; amount, or
  debit and credit; payee or description; memo; category), with the date and amount shapes banks send. Importing the
  same file twice adds nothing twice.
- Categories, corrected per transaction (each correction is a new revision; the category says where it came from).
- The month: money in, money out, and spending by category (transfers between your accounts left out).
- A JSON API for all of it (`/api/v1/…`), for the person signed in.

Plan: `OpenVibe_Plan_2026-11-13.md` §L.2. Next: rules and recurring bills, budgets, goals, OFX/QFX, the Link plugin
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
