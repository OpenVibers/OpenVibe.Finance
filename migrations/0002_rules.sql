-- phase: expand
-- Category rules (plan §L.2: "normalising, categories, rules"): "a payee containing these words is this category",
-- applied to transactions nobody has categorised (on import, and to the past when the rule is made); a category the
-- person set stays theirs. The words are sealed with the person's key like a payee (they are one); match_mark is the
-- person's HMAC of the normalised words, so the same rule is one row.
CREATE TABLE finance_rules (
    id text COLLATE "C" PRIMARY KEY,
    owner text COLLATE "C" NOT NULL,
    match_enc text NOT NULL,
    match_mark text COLLATE "C" NOT NULL,
    category text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX finance_rules_one ON finance_rules (owner, match_mark);
