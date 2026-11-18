-- phase: expand
-- A category an agent set (plan §L.2: "every category says whether it came from the provider, you, a rule or AI"):
-- category_from 'ai', written only through /mcp by something the person allowed to write (a delegated token with a
-- write grant in OpenVibe Finance). It never overwrites one the person set themselves ('you'). Older code never writes
-- it and reads it as any other origin.
ALTER TABLE finance_transactions DROP CONSTRAINT IF EXISTS finance_transactions_category_from_check;
ALTER TABLE finance_transactions ADD CONSTRAINT finance_transactions_category_from_check
    CHECK (category_from IN ('none', 'you', 'rule', 'file', 'ai'));
