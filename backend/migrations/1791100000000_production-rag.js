export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE document_chunks ADD COLUMN search_vector tsvector
      GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED;
    CREATE INDEX document_chunks_search_gin ON document_chunks USING gin (search_vector);
    CREATE INDEX document_chunks_scope ON document_chunks (organization_id, chatbot_id, document_id, chunk_index, id);
    CREATE INDEX document_embeddings_scope_model ON document_embeddings
      (organization_id, chatbot_id, provider, model, dimensions);
  `);
};
export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX document_embeddings_scope_model;
    DROP INDEX document_chunks_scope;
    DROP INDEX document_chunks_search_gin;
    ALTER TABLE document_chunks DROP COLUMN search_vector;
  `);
};
