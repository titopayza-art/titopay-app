-- ONE CHILD, ONE WALLET - AND A PARENT MAY HAVE MORE THAN ONE CHILD.
--
-- Every TitoKids child gets a real wallet: kind 'system', owned by the parent,
-- and deliberately WITHOUT a wallet number so nothing outside TitoKids can
-- reach it. idx_wallets_user_kind enforced UNIQUE (user_id, kind) across all
-- kinds, which is right for personal, business and merchant wallets and wrong
-- for children: the SECOND child's wallet collided with the first and every
-- attempt returned a 500. Observed live on 20 August 2026 - a parent could
-- only ever add one child.
--
-- The uniqueness stays for every non-system kind, enforced by the same index
-- rebuilt as a partial one under a new name. The new name is what makes all
-- three copies of this change (this migration, schema.sql, and
-- ensureTitoKidsSchema) idempotent and convergent from any starting state:
-- CREATE INDEX IF NOT EXISTS on the OLD name would silently keep the old
-- definition on a database that already had it.
DROP INDEX IF EXISTS idx_wallets_user_kind;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_user_kind_ex_system
  ON wallets (user_id, kind) WHERE kind <> 'system';

-- RESTORE THE DESIGN INVARIANT: A CHILD WALLET HAS NO WALLET NUMBER.
--
-- Two backfills (schema.sql's DO block and ensureWalletNumbersForAllWallets)
-- assigned numbers to every unnumbered wallet, child wallets included. A
-- numbered child wallet is resolvable as a transfer recipient, which lets
-- money into a child's pocket around the TitoKids allowance flow, its
-- notifications and its limits. Both backfills now skip user-owned system
-- wallets; this strips the numbers they already assigned. The platform system
-- wallet (user_id IS NULL, number 9000000001) is untouched.
UPDATE wallets
   SET wallet_number = NULL, updated_at = NOW()
 WHERE kind = 'system'
   AND user_id IS NOT NULL
   AND wallet_number IS NOT NULL;
