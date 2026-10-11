export const up = pgm => pgm.sql(`
  ALTER TABLE plans ADD COLUMN website_source_limit integer NOT NULL DEFAULT 5 CHECK (website_source_limit >= 0),
    ADD COLUMN knowledge_page_limit integer NOT NULL DEFAULT 200 CHECK (knowledge_page_limit >= 0),
    ADD COLUMN indexed_bytes_limit bigint NOT NULL DEFAULT 20000000 CHECK (indexed_bytes_limit >= 0);
  UPDATE plans SET website_source_limit=CASE code WHEN 'starter' THEN 10 WHEN 'growth' THEN 30 WHEN 'business' THEN 100 ELSE 5 END,
    knowledge_page_limit=CASE code WHEN 'starter' THEN 500 WHEN 'growth' THEN 2500 WHEN 'business' THEN 10000 ELSE 200 END;
  ALTER TABLE usage_counters DROP CONSTRAINT usage_counters_metric_check;
  ALTER TABLE usage_counters ADD CONSTRAINT usage_counters_metric_check CHECK (metric IN
    ('public_chat_messages','internal_chat_messages','documents_created','ingestion_pages','storage_bytes','api_requests',
     'website_pages_indexed','website_crawl_requests','manual_faq_entries'));
  CREATE TABLE website_sources (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, chatbot_id uuid NOT NULL,
    submitted_url text NOT NULL CHECK(length(submitted_url)<=2048), canonical_seed_url text NOT NULL,
    scheme text NOT NULL CHECK(scheme IN ('http:','https:')), host text NOT NULL, port text NOT NULL, allowed_origin text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','syncing','ready','failed','disabled')),
    sync_mode text NOT NULL DEFAULT 'manual' CHECK(sync_mode IN ('manual','daily','weekly')), next_sync_at timestamptz,
    last_attempted_at timestamptz, last_successful_at timestamptz, last_completed_run_id uuid,
    latest_error_code text, latest_error_at timestamptz, created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(organization_id,chatbot_id,id), UNIQUE(organization_id,chatbot_id,canonical_seed_url),
    FOREIGN KEY(organization_id,chatbot_id) REFERENCES chatbots(organization_id,id) ON DELETE CASCADE
  );
  CREATE INDEX website_sources_due ON website_sources(next_sync_at,id) WHERE sync_mode<>'manual' AND status<>'disabled';
  CREATE TABLE website_pages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, chatbot_id uuid NOT NULL, website_source_id uuid NOT NULL,
    canonical_url text NOT NULL CHECK(length(canonical_url)<=2048), original_url text, path text NOT NULL, title text NOT NULL,
    content_type text, http_status integer, content_hash text, etag text, last_modified text, extraction_version integer NOT NULL DEFAULT 1,
    state text NOT NULL CHECK(state IN ('active','unchanged','removed','failed','unsupported')),
    links text[] NOT NULL DEFAULT '{}', first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
    indexed_at timestamptz, removed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(organization_id,chatbot_id,website_source_id,canonical_url), UNIQUE(organization_id,chatbot_id,website_source_id,id),
    FOREIGN KEY(organization_id,chatbot_id,website_source_id) REFERENCES website_sources(organization_id,chatbot_id,id) ON DELETE CASCADE
  );
  CREATE INDEX website_pages_state ON website_pages(organization_id,chatbot_id,website_source_id,state,id);
  CREATE TABLE manual_faqs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, chatbot_id uuid NOT NULL,
    question text NOT NULL CHECK(length(btrim(question)) BETWEEN 1 AND 500), answer text NOT NULL CHECK(length(btrim(answer)) BETWEEN 1 AND 8000),
    category text NOT NULL DEFAULT '' CHECK(length(category)<=100), status text NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','disabled')),
    created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(organization_id,chatbot_id,id), FOREIGN KEY(organization_id,chatbot_id) REFERENCES chatbots(organization_id,id) ON DELETE CASCADE
  );
  CREATE TABLE knowledge_chunks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, chatbot_id uuid NOT NULL,
    website_source_id uuid, page_id uuid, faq_id uuid, chunk_index integer NOT NULL CHECK(chunk_index>=0),
    content text NOT NULL CHECK(length(content) BETWEEN 1 AND 12000), content_hash text NOT NULL, section text,
    search_vector tsvector GENERATED ALWAYS AS(to_tsvector('simple'::regconfig,content)) STORED,
    embedding vector(1024) NOT NULL, provider text NOT NULL, model text NOT NULL, dimensions integer NOT NULL DEFAULT 1024 CHECK(dimensions=1024),
    CHECK((website_source_id IS NOT NULL AND page_id IS NOT NULL AND faq_id IS NULL) OR (website_source_id IS NULL AND page_id IS NULL AND faq_id IS NOT NULL)),
    FOREIGN KEY(organization_id,chatbot_id,website_source_id,page_id) REFERENCES website_pages(organization_id,chatbot_id,website_source_id,id) ON DELETE CASCADE,
    FOREIGN KEY(organization_id,chatbot_id,faq_id) REFERENCES manual_faqs(organization_id,chatbot_id,id) ON DELETE CASCADE,
    UNIQUE(page_id,chunk_index), UNIQUE(faq_id,chunk_index)
  );
  CREATE INDEX knowledge_chunks_scope ON knowledge_chunks(organization_id,chatbot_id,website_source_id,page_id,faq_id);
  CREATE INDEX knowledge_chunks_fts ON knowledge_chunks USING gin(search_vector);
  CREATE INDEX knowledge_chunks_vector ON knowledge_chunks USING hnsw(embedding vector_cosine_ops);
  CREATE TABLE website_crawl_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, chatbot_id uuid NOT NULL, website_source_id uuid NOT NULL,
    state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','successful','failed')),
    attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), max_attempts integer NOT NULL CHECK(max_attempts BETWEEN 1 AND 10),
    available_at timestamptz NOT NULL DEFAULT now(), lease_at timestamptz, worker_id uuid, started_at timestamptz, completed_at timestamptz,
    error_code text, pages_processed integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(organization_id,chatbot_id,website_source_id) REFERENCES website_sources(organization_id,chatbot_id,id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX website_one_live_job ON website_crawl_jobs(website_source_id) WHERE state IN ('queued','running');
  CREATE INDEX website_jobs_available ON website_crawl_jobs(available_at,id) WHERE state='queued';
  CREATE INDEX website_jobs_lease ON website_crawl_jobs(lease_at) WHERE state='running';
  CREATE VIEW ready_knowledge_chunks AS
    SELECT c.id,c.organization_id,c.chatbot_id,c.document_id,d.title,c.chunk_index,c.page_number,c.section,c.content,c.search_vector,
      'document'::text AS source_type,c.document_id AS source_id,NULL::uuid AS page_id,NULL::text AS canonical_url
    FROM document_chunks c JOIN documents d ON (d.organization_id,d.chatbot_id,d.id)=(c.organization_id,c.chatbot_id,c.document_id) WHERE d.status='ready'
    UNION ALL
    SELECT c.id,c.organization_id,c.chatbot_id,coalesce(c.website_source_id,c.faq_id),coalesce(p.title,f.question),c.chunk_index,NULL::integer,c.section,c.content,c.search_vector,
      CASE WHEN c.faq_id IS NULL THEN 'website' ELSE 'manual_faq' END,coalesce(c.website_source_id,c.faq_id),p.id,p.canonical_url
    FROM knowledge_chunks c LEFT JOIN website_pages p ON (p.organization_id,p.chatbot_id,p.website_source_id,p.id)=(c.organization_id,c.chatbot_id,c.website_source_id,c.page_id)
    LEFT JOIN website_sources s ON (s.organization_id,s.chatbot_id,s.id)=(c.organization_id,c.chatbot_id,c.website_source_id)
    LEFT JOIN manual_faqs f ON (f.organization_id,f.chatbot_id,f.id)=(c.organization_id,c.chatbot_id,c.faq_id)
    WHERE (p.state IN ('active','unchanged') AND s.status IN ('ready','syncing','failed')) OR f.status='ready';
  CREATE VIEW knowledge_vectors AS SELECT chunk_id,document_id,organization_id,chatbot_id,embedding,provider,model,dimensions FROM document_embeddings
    UNION ALL SELECT id,coalesce(website_source_id,faq_id),organization_id,chatbot_id,embedding,provider,model,dimensions FROM knowledge_chunks;
`);
export const down = () => { throw new Error('M28 rollback requires a reviewed export and forward migration.'); };
