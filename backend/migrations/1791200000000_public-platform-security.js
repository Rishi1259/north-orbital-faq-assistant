export const up = pgm => {
  pgm.sql(`
    ALTER TABLE chatbots
      ADD COLUMN public_id text NOT NULL DEFAULT ('pub_' || encode(gen_random_bytes(24), 'hex')) UNIQUE,
      ADD COLUMN public_enabled boolean NOT NULL DEFAULT false,
      ADD COLUMN display_name text NOT NULL DEFAULT 'North Orbital Assistant' CHECK (length(display_name) BETWEEN 1 AND 80),
      ADD COLUMN welcome_message text NOT NULL DEFAULT 'Hello! How can I help?' CHECK (length(welcome_message) BETWEEN 1 AND 500),
      ADD COLUMN accent_color text NOT NULL DEFAULT '#2563EB' CHECK (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
      ADD COLUMN launcher_label text NOT NULL DEFAULT 'Chat with us' CHECK (length(launcher_label) BETWEEN 1 AND 40),
      ADD COLUMN launcher_position text NOT NULL DEFAULT 'bottom-right' CHECK (launcher_position IN ('bottom-right','bottom-left'));
    CREATE TABLE chatbot_allowed_origins (
      organization_id uuid NOT NULL,
      chatbot_id uuid NOT NULL,
      origin text NOT NULL CHECK (length(origin) <= 300),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, chatbot_id, origin),
      FOREIGN KEY (chatbot_id, organization_id) REFERENCES chatbots(id, organization_id) ON DELETE CASCADE
    );
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL CHECK (length(email) <= 254 AND email = lower(email)),
      password_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX users_email_ci ON users(lower(email));
    CREATE TABLE organization_memberships (
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role text NOT NULL CHECK (role IN ('owner','admin','member')),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id,user_id)
    );
    CREATE INDEX memberships_user ON organization_memberships(user_id,organization_id);
    CREATE TABLE auth_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE CHECK (length(token_hash)=64),
      csrf_hash text NOT NULL CHECK (length(csrf_hash)=64),
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX sessions_expiry ON auth_sessions(expires_at);
    CREATE TABLE rate_limit_windows (
      key_hash text NOT NULL CHECK (length(key_hash)=64),
      window_start bigint NOT NULL,
      expires_at timestamptz NOT NULL,
      hits integer NOT NULL CHECK (hits > 0),
      PRIMARY KEY(key_hash,window_start)
    );
    CREATE INDEX rate_limits_expiry ON rate_limit_windows(expires_at);
    -- Audit identifiers are historical snapshots, deliberately without cascading FKs.
    CREATE TABLE audit_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid,
      actor_user_id uuid,
      chatbot_id uuid,
      action text NOT NULL CHECK (length(action) <= 80),
      target_type text NOT NULL CHECK (length(target_type) <= 40),
      target_id uuid,
      request_id uuid,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(metadata::text) <= 2048),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX audit_org_time ON audit_events(organization_id,created_at DESC,id DESC);
    CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Audit events are append-only'; END;
    $$;
    CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_events
      FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
  `);
};
export const down = () => { throw new Error('Security migration is forward-only; restore a verified backup for disaster recovery.'); };
