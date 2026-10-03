export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE chatbots
      ADD CONSTRAINT chatbots_id_organization_unique
      UNIQUE (id, organization_id);

    CREATE TABLE documents (
      id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

      organization_id UUID NOT NULL
        REFERENCES organizations(id)
        ON DELETE CASCADE,

      chatbot_id UUID NOT NULL,

      title TEXT NOT NULL,

      original_filename TEXT NOT NULL,

      mime_type TEXT NOT NULL,

      storage_key TEXT,

      checksum_sha256 TEXT,

      status TEXT NOT NULL
        DEFAULT 'pending'
        CHECK (
          status IN (
            'pending',
            'processing',
            'ready',
            'failed'
          )
        ),

      error_message TEXT,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      updated_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT documents_chatbot_organization_fk
        FOREIGN KEY (
          chatbot_id,
          organization_id
        )
        REFERENCES chatbots (
          id,
          organization_id
        )
        ON DELETE CASCADE,

      CONSTRAINT documents_id_scope_unique
        UNIQUE (
          id,
          organization_id,
          chatbot_id
        )
    );

    CREATE TABLE document_chunks (
      id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

      organization_id UUID NOT NULL,

      chatbot_id UUID NOT NULL,

      document_id UUID NOT NULL,

      chunk_index INTEGER NOT NULL
        CHECK (chunk_index >= 0),

      block_id TEXT,

      content TEXT NOT NULL,

      page_number INTEGER
        CHECK (
          page_number IS NULL
          OR page_number > 0
        ),

      section TEXT,

      token_count INTEGER
        CHECK (
          token_count IS NULL
          OR token_count >= 0
        ),

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT document_chunks_document_scope_fk
        FOREIGN KEY (
          document_id,
          organization_id,
          chatbot_id
        )
        REFERENCES documents (
          id,
          organization_id,
          chatbot_id
        )
        ON DELETE CASCADE,

      CONSTRAINT document_chunks_document_index_unique
        UNIQUE (
          document_id,
          chunk_index
        ),

      CONSTRAINT document_chunks_id_scope_unique
        UNIQUE (
          id,
          organization_id,
          chatbot_id,
          document_id
        )
    );

    CREATE TABLE document_embeddings (
      id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

      organization_id UUID NOT NULL,

      chatbot_id UUID NOT NULL,

      document_id UUID NOT NULL,

      chunk_id UUID NOT NULL,

      provider TEXT NOT NULL,

      model TEXT NOT NULL,

      dimensions INTEGER NOT NULL
        CHECK (dimensions = 1024),

      embedding vector(1024) NOT NULL,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT document_embeddings_chunk_scope_fk
        FOREIGN KEY (
          chunk_id,
          organization_id,
          chatbot_id,
          document_id
        )
        REFERENCES document_chunks (
          id,
          organization_id,
          chatbot_id,
          document_id
        )
        ON DELETE CASCADE,

      CONSTRAINT document_embeddings_chunk_model_unique
        UNIQUE (
          chunk_id,
          provider,
          model
        )
    );

    CREATE INDEX documents_organization_id_index
      ON documents (organization_id);

    CREATE INDEX documents_chatbot_id_index
      ON documents (chatbot_id);

    CREATE INDEX documents_status_index
      ON documents (status);

    CREATE INDEX document_chunks_organization_id_index
      ON document_chunks (organization_id);

    CREATE INDEX document_chunks_chatbot_id_index
      ON document_chunks (chatbot_id);

    CREATE INDEX document_chunks_document_id_index
      ON document_chunks (document_id);

    CREATE INDEX document_embeddings_organization_id_index
      ON document_embeddings (organization_id);

    CREATE INDEX document_embeddings_chatbot_id_index
      ON document_embeddings (chatbot_id);

    CREATE INDEX document_embeddings_chunk_id_index
      ON document_embeddings (chunk_id);

    CREATE INDEX document_embeddings_embedding_hnsw_index
      ON document_embeddings
      USING hnsw (
        embedding vector_cosine_ops
      );
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS document_embeddings;
    DROP TABLE IF EXISTS document_chunks;
    DROP TABLE IF EXISTS documents;

    ALTER TABLE chatbots
      DROP CONSTRAINT IF EXISTS
        chatbots_id_organization_unique;
  `);
};