export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE documents
      ADD COLUMN size_bytes bigint CHECK (size_bytes >= 0),
      ADD COLUMN processed_at timestamptz,
      ADD COLUMN ocr_used boolean NOT NULL DEFAULT false,
      ADD COLUMN page_count integer CHECK (page_count > 0),
      ADD COLUMN chunk_count integer CHECK (chunk_count >= 0);

    CREATE TABLE document_ingestion_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      chatbot_id uuid NOT NULL,
      document_id uuid NOT NULL,
      status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'processing', 'succeeded', 'failed')),
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
      available_at timestamptz NOT NULL DEFAULT now(),
      locked_at timestamptz,
      locked_by text,
      last_error text CHECK (length(last_error) <= 300),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      CHECK (attempts <= max_attempts),
      CHECK ((status = 'processing') = (locked_at IS NOT NULL AND locked_by IS NOT NULL)),
      CHECK ((status IN ('succeeded', 'failed')) = (completed_at IS NOT NULL)),
      FOREIGN KEY (document_id, organization_id, chatbot_id)
        REFERENCES documents (id, organization_id, chatbot_id) ON DELETE CASCADE
    );
    CREATE INDEX ingestion_jobs_scope ON document_ingestion_jobs
      (organization_id, chatbot_id, document_id);
    CREATE INDEX ingestion_jobs_available ON document_ingestion_jobs (status, available_at)
      WHERE status = 'queued';
    CREATE INDEX ingestion_jobs_stale ON document_ingestion_jobs (locked_at)
      WHERE status = 'processing';
    CREATE UNIQUE INDEX ingestion_jobs_one_active ON document_ingestion_jobs
      (organization_id, chatbot_id, document_id) WHERE status IN ('queued', 'processing');
    CREATE INDEX documents_scope_created ON documents (organization_id, chatbot_id, created_at, id);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE document_ingestion_jobs;
    DROP INDEX documents_scope_created;
    ALTER TABLE documents DROP COLUMN size_bytes, DROP COLUMN processed_at,
      DROP COLUMN ocr_used, DROP COLUMN page_count, DROP COLUMN chunk_count;
  `);
};
