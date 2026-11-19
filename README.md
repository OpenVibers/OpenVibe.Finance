# OpenVibe.Finance

**Your money, your rules, your data** — [openvibe.finance](https://openvibe.finance), part of the OpenVibe network.

Your accounts in one place, from a bank's CSV export or typed in, and a clear picture of each month. Free, with nothing
to connect.

- **Private to you.** Payees and notes are stored encrypted under a key derived for your account alone
  (`server/crypto.js`). Nothing here enters search, analytics or AI training.
- **No money moves.** It reads and plans; it never pays, transfers or cancels anything.
- **Yours to take.** Download everything as one JSON file, or delete everything, at `/data`.

## What it does today (v0.12)

- Accounts (checking, savings, credit card, cash, loan, investments) with an opening balance and a running balance.
- Transactions typed in, or imported from a bank's download:
  - CSV: the columns are read from the header (date; amount, or debit and credit; payee or description; memo;
    category), with the date and amount shapes banks send;
  - OFX and QFX (Quicken), 1.x and 2.x, bank and credit-card statements: the bank's own transaction id (FITID) makes
    repeated and overlapping downloads add each transaction once.
  - a PDF statement (text PDFs): read on openvibe.finance and never sent anywhere; the lines with a date and an
    amount, money in and out as marked (or as the person chooses when nothing marks them), checked before importing.
  Importing the same file twice adds nothing twice.
- A receipt photo: read on openvibe.finance by Tesseract, from memory (never written, sent or kept); the store, the
  day and the total fill the add form, and what was not clear is said, for the person to check before adding it.
- Categories, corrected per transaction (each correction is a new revision; the category says where it came from).
- Category rules: tick **Always** on a transaction's category and every transaction whose payee contains its words
  goes there, past and future imports (never one you categorised yourself). `/rules` lists and removes them.
- The month: money in, money out, and spending by category (transfers between your accounts left out).
- Net worth and what if: net worth at each month's end since the data starts; the average month of the last three
  repeated a year ahead, with a one-off cost ("can I afford it?": yes, or not yet and the month it would fit) or a
  monthly change ("what if rent rises?"), against the goals' monthly need.
- Goals: an amount to reach, by a date or not, tracking a savings account or an amount kept by hand; the page says
  what a month reaches it in time.
- Debt: a loan's or card's yearly rate and monthly payment give when it is paid off, the interest it costs, and what
  paying a little more saves.
- Budgets: a monthly limit per category of spending; the month shows each against its limit (left, or over) and the
  rest of the spending beside them.
- Recurring: bills, subscriptions and regular income found in your own transactions (the same payee and a similar
  amount at a steady rhythm, three times or more): what each costs a month, when the next is due, and which stopped.
- A JSON API for all of it (`/api/v1/…`), for the person signed in.

Plan: `OpenVibe_Plan_2026-11-13.md` §L.2. Next: the Link plugin
for local-only import, and Finance Experts (Budget Coach, Subscription Auditor) with narrow read permission.

## For agents: /mcp

OpenVibe's money Experts on Actor (Budget coach, Can I afford it?, Debt planner, Subscription auditor) use it once the
person allows Actor in OpenVibe Finance on their Apps page; the home page links them.

`POST https://openvibe.finance/mcp` is an MCP server (both eras: the 2026-07-28 stateless protocol and the handshake
one). Seven tools read: `accounts`, `month`, `transactions`, `recurring`, `goals`, `net_worth`, `what_if`. Four write,
with the person's own sign-in or a write grant (v0.10): `import_statement` (CSV, OFX or QFX text), `add_transaction`,
`categorize` (up to 200; a category an agent sets is marked "agent" on the page and never overwrites one the person
set), `add_rule`. Nothing deletes; nothing moves money. Amounts are integer cents; months are `YYYY-MM`.

- Anyone may list the tools. A call reads the person from a **Bearer token only**, never a cookie: their own sign-in,
  or a delegated person token naming `finance` (openvibe-sdk 0.187), which OpenVibe.Network mints per call for a key
  or an agent with a grant in **OpenVibe Finance** (Connect; `https://connect.openvibe.network/mcp/all`).
- The pages and the JSON API never take a delegated token: only the person changes anything, and nothing here moves
  money.

## Running

```bash
npm install
npm test                                   # PGlite, a real PostgreSQL in-process
node test/harness/serve-sample.js 18471    # a local look with sample data and a stand-in sign-in
```

Production: `/opt/openvibe.finance`, unit `openvibe-finance.service` (port 5292), env `/etc/openvibe/finance.env`
(`.env.example`), nginx `deploy/nginx/openvibe.finance.conf`. Sign-in is OpenVibe.Network's OAuth client `finance`.

License: AGPL-3.0-only.

<!-- versions:start -->
- openvibe-sdk: v0.188.0
- openvibe-shared: v4.320.0
<!-- versions:end -->
