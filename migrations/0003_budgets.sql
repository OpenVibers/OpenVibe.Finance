-- phase: expand
-- Budgets (plan §L.2: "budgets (envelope, category, flex, paycheck, none)"), the category kind first: a monthly limit
-- for a category of spending, the same every month until changed. The month page sets the limit against what the
-- category spent. A person with no budgets has none (the "none" kind): nothing nags.
CREATE TABLE finance_budgets (
    owner text COLLATE "C" NOT NULL,
    category text NOT NULL,
    monthly_cents bigint NOT NULL CHECK (monthly_cents > 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner, category)
);
