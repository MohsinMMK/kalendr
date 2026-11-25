-- Preserve account identities; do not merge duplicate provider keys.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM auth_accounts
    GROUP BY provider_id, account_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Resolve duplicate auth_accounts (provider_id, account_id) identities before migrating';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "auth_accounts" DROP CONSTRAINT "auth_accounts_issuer_account_uq";
--> statement-breakpoint
ALTER TABLE "auth_accounts" ALTER COLUMN "issuer" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_provider_account_uq" UNIQUE("provider_id","account_id");
