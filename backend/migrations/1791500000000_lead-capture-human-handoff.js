// Additive M29 schema. Existing tenant data and prior migrations are untouched.
export const up = pgm => pgm.sql(`
  ALTER TABLE plans ADD COLUMN lead_capture_enabled boolean NOT NULL DEFAULT true,
    ADD COLUMN human_handoff_enabled boolean NOT NULL DEFAULT true,
    ADD COLUMN monthly_lead_limit integer NOT NULL DEFAULT 100 CHECK(monthly_lead_limit>=0),
    ADD COLUMN monthly_handoff_limit integer NOT NULL DEFAULT 25 CHECK(monthly_handoff_limit>=0);
  UPDATE plans SET monthly_lead_limit=CASE code WHEN 'starter' THEN 500 WHEN 'growth' THEN 2500 WHEN 'business' THEN 10000 ELSE 100 END,
    monthly_handoff_limit=CASE code WHEN 'starter' THEN 100 WHEN 'growth' THEN 500 WHEN 'business' THEN 2500 ELSE 25 END;
  ALTER TABLE usage_counters DROP CONSTRAINT usage_counters_metric_check;
  ALTER TABLE usage_counters ADD CONSTRAINT usage_counters_metric_check CHECK(metric IN
    ('public_chat_messages','internal_chat_messages','documents_created','ingestion_pages','storage_bytes','api_requests',
     'website_pages_indexed','website_crawl_requests','manual_faq_entries','leads_created','handoffs_requested'));
  CREATE TABLE lead_capture_settings (
    organization_id uuid NOT NULL, chatbot_id uuid NOT NULL,
    enabled boolean NOT NULL DEFAULT false, handoff_enabled boolean NOT NULL DEFAULT false,
    form_title text NOT NULL DEFAULT 'Contact us' CHECK(length(btrim(form_title)) BETWEEN 1 AND 120),
    form_message text NOT NULL DEFAULT 'Leave your details for our team.' CHECK(length(form_message)<=1000),
    success_message text NOT NULL DEFAULT 'Thank you. Your request has been received.' CHECK(length(btrim(success_message)) BETWEEN 1 AND 500),
    collect_name boolean NOT NULL DEFAULT true, require_name boolean NOT NULL DEFAULT false,
    collect_email boolean NOT NULL DEFAULT true, require_email boolean NOT NULL DEFAULT true,
    collect_phone boolean NOT NULL DEFAULT false, require_phone boolean NOT NULL DEFAULT false,
    collect_company boolean NOT NULL DEFAULT false, require_company boolean NOT NULL DEFAULT false,
    collect_message boolean NOT NULL DEFAULT true, require_message boolean NOT NULL DEFAULT false,
    consent_required boolean NOT NULL DEFAULT false, consent_text text NOT NULL DEFAULT '' CHECK(length(consent_text)<=1000),
    consent_version integer NOT NULL DEFAULT 1 CHECK(consent_version>0),
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(organization_id,chatbot_id),
    FOREIGN KEY(organization_id,chatbot_id) REFERENCES chatbots(organization_id,id) ON DELETE CASCADE,
    CHECK(NOT require_name OR collect_name), CHECK(NOT require_email OR collect_email),
    CHECK(NOT require_phone OR collect_phone), CHECK(NOT require_company OR collect_company), CHECK(NOT require_message OR collect_message),
    CHECK(NOT handoff_enabled OR (enabled AND (collect_email OR collect_phone))),
    CHECK(NOT consent_required OR length(btrim(consent_text))>0)
  );
  CREATE TABLE leads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, chatbot_id uuid NOT NULL,
    source text NOT NULL CHECK(source IN ('widget','public_api')),
    name text CHECK(length(name) BETWEEN 1 AND 200), normalized_email text CHECK(length(normalized_email) BETWEEN 3 AND 254),
    phone text CHECK(length(phone) BETWEEN 3 AND 40), company text CHECK(length(company) BETWEEN 1 AND 200),
    visitor_message text CHECK(length(visitor_message) BETWEEN 1 AND 2000),
    status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','qualified','closed')),
    consent_given boolean NOT NULL, consent_version integer NOT NULL CHECK(consent_version>0), consent_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK(consent_given=(consent_at IS NOT NULL)), UNIQUE(organization_id,chatbot_id,id),
    FOREIGN KEY(organization_id,chatbot_id) REFERENCES chatbots(organization_id,id) ON DELETE CASCADE
  );
  CREATE INDEX leads_page ON leads(organization_id,chatbot_id,created_at DESC,id DESC);
  CREATE INDEX leads_status ON leads(organization_id,chatbot_id,status,created_at DESC,id DESC);
  CREATE TABLE handoff_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, chatbot_id uuid NOT NULL, lead_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','acknowledged','resolved','cancelled')),
    reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000), assigned_user_id uuid,
    revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
    requested_at timestamptz NOT NULL DEFAULT now(), acknowledged_at timestamptz, resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(organization_id,chatbot_id,lead_id) REFERENCES leads(organization_id,chatbot_id,id) ON DELETE CASCADE,
    FOREIGN KEY(organization_id,assigned_user_id) REFERENCES organization_memberships(organization_id,user_id) ON DELETE SET NULL (assigned_user_id),
    CHECK(status<>'acknowledged' OR acknowledged_at IS NOT NULL), CHECK(status<>'resolved' OR resolved_at IS NOT NULL)
  );
  CREATE INDEX handoffs_page ON handoff_requests(organization_id,chatbot_id,created_at DESC,id DESC);
  CREATE INDEX handoffs_status ON handoff_requests(organization_id,chatbot_id,status,created_at DESC,id DESC);
  CREATE INDEX handoffs_lead ON handoff_requests(organization_id,chatbot_id,lead_id);
  CREATE INDEX handoffs_assignment ON handoff_requests(organization_id,assigned_user_id);
  -- No contact data or resource IDs: deletion retains retry protection for 24 hours.
  CREATE TABLE lead_submission_receipts (
    organization_id uuid NOT NULL, chatbot_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('lead','handoff')),
    key_hash text NOT NULL CHECK(key_hash ~ '^[a-f0-9]{64}$'), expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
    PRIMARY KEY(organization_id,chatbot_id,kind,key_hash),
    FOREIGN KEY(organization_id,chatbot_id) REFERENCES chatbots(organization_id,id) ON DELETE CASCADE
  );
  CREATE INDEX lead_receipts_expiry ON lead_submission_receipts(expires_at);
`);
export const down = () => { throw new Error('M29 rollback requires an explicit data-preservation plan.'); };
