-- phase: expand
-- OpenVibe.Finance (plan §L.2: "your money, your rules, your data"): a person's accounts and transactions, entered by
-- hand or imported from a bank's CSV. Read and plan only: no money moves.
--   * Every row belongs to one person (owner: their usr_ subject). Nothing here is public, searched, counted in
--     analytics or used for training.
--   * Payees and notes are stored encrypted with a key for that person alone (server/crypto.js); amounts, dates and
--     categories stay plain so the person's own sums can be computed.
--   * Money is integer cents in the account's currency.
--   * A raw import row never changes: a correction (a category, a payee) is a revision on the transaction, and the
--     category says where it came from (you, a rule, the bank's file).

CREATE TABLE finance_accounts (
    id text COLLATE "C" PRIMARY KEY,
    owner text COLLATE "C" NOT NULL,
    name text NOT NULL,
    kind text COLLATE "C" NOT NULL CHECK (kind IN ('checking', 'savings', 'credit', 'cash', 'loan', 'investment', 'other')),
    currency text COLLATE "C" NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
    opening_cents bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz
);
CREATE INDEX finance_accounts_owner ON finance_accounts (owner, created_at);

CREATE TABLE finance_imports (
    id text COLLATE "C" PRIMARY KEY,
    owner text COLLATE "C" NOT NULL,
    account_id text COLLATE "C" NOT NULL REFERENCES finance_accounts (id) ON DELETE CASCADE,
    format text COLLATE "C" NOT NULL DEFAULT 'csv',
    rows_read integer NOT NULL DEFAULT 0,
    rows_added integer NOT NULL DEFAULT 0,
    rows_skipped integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX finance_imports_owner ON finance_imports (owner, created_at);

CREATE TABLE finance_transactions (
    id text COLLATE "C" PRIMARY KEY,
    owner text COLLATE "C" NOT NULL,
    account_id text COLLATE "C" NOT NULL REFERENCES finance_accounts (id) ON DELETE CASCADE,
    posted_on date NOT NULL,
    amount_cents bigint NOT NULL,
    payee_enc text NOT NULL DEFAULT '',
    memo_enc text NOT NULL DEFAULT '',
    category text NOT NULL DEFAULT 'Uncategorized',
    category_from text COLLATE "C" NOT NULL DEFAULT 'none' CHECK (category_from IN ('none', 'you', 'rule', 'file')),
    import_id text COLLATE "C" REFERENCES finance_imports (id) ON DELETE SET NULL,
    -- The same bank row imported twice is one transaction: an HMAC (the person's key) of its account, date, amount and
    -- payee, and its place among identical rows in the file.
    dedupe text COLLATE "C",
    revision integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX finance_transactions_account ON finance_transactions (account_id, posted_on DESC, id);
CREATE INDEX finance_transactions_owner_month ON finance_transactions (owner, posted_on);
CREATE UNIQUE INDEX finance_transactions_dedupe ON finance_transactions (account_id, dedupe) WHERE dedupe IS NOT NULL;
