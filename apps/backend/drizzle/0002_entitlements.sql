-- Plans per account (src/db/schema.ts `entitlements`; specs/entitlements.feature.md). No row means
-- `free`. The CHECK lists `PLANS` (specs/entitlements-snapshot.spec.ts); a new plan needs a new
-- migration. Forward-only: never edit once applied.
CREATE TABLE entitlements (
  user_id text PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  plan text NOT NULL CHECK (plan IN ('free', 'pro')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
