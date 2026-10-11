export const up = pgm => pgm.sql(`
  CREATE TABLE plans (
    code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{0,39}$'),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    monthly_price_inr_minor bigint CHECK (monthly_price_inr_minor BETWEEN 0 AND 9007199254740991),
    monthly_price_usd_minor bigint CHECK (monthly_price_usd_minor BETWEEN 0 AND 9007199254740991),
    chatbot_limit integer NOT NULL CHECK (chatbot_limit >= 0),
    monthly_message_limit integer NOT NULL CHECK (monthly_message_limit >= 0),
    document_limit integer NOT NULL CHECK (document_limit >= 0),
    storage_bytes_limit bigint NOT NULL CHECK (storage_bytes_limit BETWEEN 0 AND 9007199254740991),
    team_member_limit integer NOT NULL CHECK (team_member_limit > 0),
    monthly_ingestion_page_limit integer CHECK (monthly_ingestion_page_limit >= 0),
    api_access boolean NOT NULL DEFAULT false,
    advanced_analytics boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  INSERT INTO plans(code,name,chatbot_limit,monthly_message_limit,document_limit,storage_bytes_limit,team_member_limit,api_access,advanced_analytics)
    VALUES ('beta','Beta',1,1000,25,250000000,2,false,false),
      ('starter','Starter',1,3000,50,1000000000,3,false,false),
      ('growth','Growth',3,15000,250,5000000000,10,true,true),
      ('business','Business',10,50000,1000,20000000000,30,true,true);
  CREATE TABLE organization_subscriptions (
    organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    plan_code text NOT NULL REFERENCES plans(code),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('trialing','active','past_due','suspended','cancelled')),
    current_period_start timestamptz NOT NULL DEFAULT now(),
    current_period_end timestamptz NOT NULL DEFAULT (now()+interval '30 days'),
    trial_ends_at timestamptz, grace_ends_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (isfinite(current_period_start) AND isfinite(current_period_end) AND current_period_end > current_period_start),
    CHECK (trial_ends_at IS NULL OR isfinite(trial_ends_at)),
    CHECK (grace_ends_at IS NULL OR isfinite(grace_ends_at))
  );
  CREATE INDEX subscriptions_plan ON organization_subscriptions(plan_code);
  INSERT INTO organization_subscriptions(organization_id,plan_code) SELECT id,'beta' FROM organizations;
  CREATE FUNCTION commercial_default_subscription() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO organization_subscriptions(organization_id,plan_code) VALUES(NEW.id,'beta'); RETURN NEW; END;
  $$;
  CREATE TRIGGER organization_subscription AFTER INSERT ON organizations FOR EACH ROW EXECUTE FUNCTION commercial_default_subscription();
  CREATE TABLE usage_counters (
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    metric text NOT NULL CHECK (metric IN ('public_chat_messages','internal_chat_messages','documents_created','ingestion_pages','storage_bytes','api_requests')),
    period_start timestamptz NOT NULL, period_end timestamptz NOT NULL,
    quantity bigint NOT NULL CHECK (quantity BETWEEN 0 AND 9007199254740991),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(organization_id,metric,period_start), CHECK (period_end > period_start)
  );
  CREATE INDEX usage_period ON usage_counters(organization_id,period_start,period_end);
  CREATE TABLE api_keys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
    key_prefix text NOT NULL CHECK (length(key_prefix) BETWEEN 8 AND 24),
    secret_hash text NOT NULL UNIQUE CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
    scopes text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 5 AND array_position(scopes,NULL) IS NULL
      AND scopes <@ ARRAY['chat:write','chatbots:read','documents:read','documents:write','analytics:read']::text[]),
    created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz, revoked_at timestamptz, last_used_at timestamptz,
    CHECK (expires_at IS NULL OR (isfinite(expires_at) AND expires_at > created_at))
  );
  CREATE INDEX api_keys_org ON api_keys(organization_id,created_at DESC,id DESC);
  -- Intentionally independent of tenant FKs: cleanup survives metadata/account removal.
  -- Upload intents reserve capacity before PUT and remain durable until DB finalization.
  CREATE TABLE object_cleanup_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, chatbot_id uuid NOT NULL,
    document_id uuid NOT NULL UNIQUE, format text NOT NULL CHECK (format IN ('pdf','docx')),
    purpose text NOT NULL CHECK (purpose IN ('upload','delete')),
    size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 9007199254740991),
    available_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX object_cleanup_due ON object_cleanup_jobs(available_at,id);
  CREATE INDEX object_cleanup_org ON object_cleanup_jobs(organization_id,purpose);
`);
export const down = pgm => pgm.sql(`
  DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM object_cleanup_jobs) THEN RAISE EXCEPTION 'Drain object cleanup jobs before rollback'; END IF;
  END $$;
  DROP TABLE object_cleanup_jobs, api_keys, usage_counters;
  DROP TRIGGER organization_subscription ON organizations;
  DROP FUNCTION commercial_default_subscription();
  DROP TABLE organization_subscriptions, plans;
`);
