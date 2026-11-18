# AGENTS.md — OpenVibe.Finance

A person's own money data (plan §L.2): accounts, transactions, CSV imports and the month. Node/Express, server-rendered
in the network's shell (openvibe-shared), PostgreSQL through `openvibe-sdk/db` (PGlite in tests).

## Rules (the most sensitive data on the network)
- **Every query names the owner** (`store.js`); a page or route never reads a row by id alone.
- **Payees and memos are sealed** with the person's key (`server/crypto.js`); never log them, never return them to
  anyone but their owner. Amounts, dates and categories stay plain for the person's own sums.
- **Nothing leaves:** no search index, no analytics events with content, no training data, no third-party script.
- **No money moves.** Paying, transferring or cancelling is a separate, later decision with its own review.
- **Writes are same-origin** (a page form) or a Bearer call; answers are `private, no-store` and `noindex`.
- **Export and deletion stay complete:** a new table gets its rows in `exportAll` and `removeAll` in the same change.
- **Migrations:** `migrations/NNNN_name.sql` with `-- phase:`; never edit one that has run.

## Commands
`npm test` (all, PGlite) · `node test/<name>.test.js` · `node test/harness/serve-sample.js 18471` (a local look).
Style: 4 spaces, single quotes, semicolons, CommonJS.
