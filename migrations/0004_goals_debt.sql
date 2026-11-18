-- phase: expand
-- Goals and debt (plan §L.2: "goals and debt").
--   * A goal: an amount to reach, by a date or not; its progress is an account's balance (a savings account set aside
--     for it) or an amount the person keeps up to date by hand.
--   * Debt: a loan or a card account may say its yearly interest rate (basis points: 2499 is 24.99%) and the payment
--     made each month; the page works out when it is paid off and what the interest costs.
CREATE TABLE finance_goals (
    id text COLLATE "C" PRIMARY KEY,
    owner text COLLATE "C" NOT NULL,
    name text NOT NULL,
    target_cents bigint NOT NULL CHECK (target_cents > 0),
    target_on date,
    account_id text COLLATE "C" REFERENCES finance_accounts (id) ON DELETE SET NULL,
    saved_cents bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX finance_goals_owner ON finance_goals (owner, created_at);

ALTER TABLE finance_accounts ADD COLUMN IF NOT EXISTS apr_bps integer CHECK (apr_bps IS NULL OR (apr_bps >= 0 AND apr_bps <= 10000));
ALTER TABLE finance_accounts ADD COLUMN IF NOT EXISTS payment_cents bigint CHECK (payment_cents IS NULL OR payment_cents > 0);
