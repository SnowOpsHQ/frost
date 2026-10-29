-- Desktop authorization (src/db/schema.ts `desktopCodes`, `desktopTokens`;
-- specs/account-backend.feature.md, Desktop authorization). Only SHA-256 hashes (64 lowercase hex
-- characters, enforced below) of codes and tokens are stored, never the values themselves.
-- Forward-only: never edit once applied.
CREATE TABLE desktop_codes (
  code_hash text PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_challenge text NOT NULL,
  redirect_uri text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
--> statement-breakpoint
CREATE INDEX desktop_codes_user_id_idx ON desktop_codes (user_id);
--> statement-breakpoint
CREATE INDEX desktop_codes_expires_at_idx ON desktop_codes (expires_at);
--> statement-breakpoint
CREATE TABLE desktop_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash text CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz
);
--> statement-breakpoint
CREATE INDEX desktop_tokens_user_id_idx ON desktop_tokens (user_id);
--> statement-breakpoint
CREATE INDEX desktop_tokens_code_hash_idx ON desktop_tokens (code_hash);
