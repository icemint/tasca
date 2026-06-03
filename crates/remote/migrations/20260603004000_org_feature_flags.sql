-- Per-org feature flags (#156). A JSONB map of flag-name → bool; '{}' means the
-- org has set nothing, so flags fall through to env/default-off on the client.
-- The org layer is the production rollout lever (org flag > env > default).
-- Not Electric-synced: organizations are fetched over REST (list_user_organizations),
-- so the flags ride on that payload — no shape/publication needed.
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS feature_flags jsonb NOT NULL DEFAULT '{}'::jsonb;
