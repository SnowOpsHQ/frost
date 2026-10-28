-- A code presented again while (or after) its first exchange runs is marked here; the first exchange
-- re-reads the mark after storing its token and revokes it (src/desktop-auth.ts;
-- specs/account-backend.feature.md, Desktop authorization). Forward-only: never edit once applied.
ALTER TABLE desktop_codes ADD COLUMN replayed_at timestamptz;
