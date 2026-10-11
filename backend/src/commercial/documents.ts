import type { CommercialService } from './service.js';
import { transaction } from './repository.js';
import { appendAudit, type Audit } from '../security/repository.js';
import { HttpError, notFound } from '../security/errors.js';
import type { ObjectStorage } from '../storage/object-storage.js';
import type { NewDocument, StoredDocument, DocumentScope } from '../ingestion/types.js';
export class CommercialDocuments {
  constructor(private commercial: CommercialService) {}
  async upload(input: NewDocument, storage: ObjectStorage, filePath: string) {
    const org = input.organizationId;
    // Commit intent before touching storage. Capacity includes all outstanding intents.
    await this.commercial.run(org,async(db,{subscription:s,plan:p})=>{
      if (!(await db.query('SELECT id FROM chatbots WHERE organization_id=$1 AND id=$2',[org,input.chatbotId])).rowCount) throw notFound();
      await this.commercial.checkResource(db,org,s,p,'documents',input.size);
      await db.query(`INSERT INTO object_cleanup_jobs(organization_id,chatbot_id,document_id,format,purpose,size_bytes,available_at)
        VALUES($1,$2,$3,$4,'upload',$5,now()+interval '1 hour')`,[org,input.chatbotId,input.documentId,input.format,input.size]);
    });
    // Hold the intent lock across PUT and commit. Cleanup cannot race a live upload.
    // On crash/ambiguous PUT/commit failure, the committed intent remains for the worker.
    return this.commercial.run(org,async(db,{subscription:s})=>{
      const intent = await db.query("SELECT id FROM object_cleanup_jobs WHERE organization_id=$1 AND document_id=$2 AND purpose='upload' FOR UPDATE",[org,input.documentId]);
      if (!intent.rowCount) throw new HttpError(409,'UPLOAD_EXPIRED','Upload reservation expired. Please retry.');
      await storage.put(input,filePath,input.mimeType);
      const doc = (await db.query<StoredDocument>(`INSERT INTO documents(organization_id,chatbot_id,id,title,original_filename,mime_type,storage_key,checksum_sha256,size_bytes)
        VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8) RETURNING *`,[org,input.chatbotId,input.documentId,input.filename,input.mimeType,input.storageKey,input.checksum,input.size])).rows[0];
      await db.query('INSERT INTO document_ingestion_jobs(organization_id,chatbot_id,document_id,max_attempts) VALUES($1,$2,$3,$4)',[org,input.chatbotId,input.documentId,input.maxAttempts]);
      await this.commercial.meter(db,s,'documents_created');
      await this.commercial.meter(db,s,'storage_bytes',input.size);
      await db.query('DELETE FROM object_cleanup_jobs WHERE id=$1',[intent.rows[0].id]);
      return doc;
    });
  }
  async delete(scope: DocumentScope, audit: Audit) {
    return this.commercial.run(scope.organizationId,async db=>{
      const values = [scope.organizationId,scope.chatbotId,scope.documentId];
      // Worker completion takes job before document locks; preserve that order.
      await db.query('SELECT id FROM document_ingestion_jobs WHERE organization_id=$1 AND chatbot_id=$2 AND document_id=$3 FOR UPDATE',values);
      const doc = (await db.query<StoredDocument>('SELECT * FROM documents WHERE organization_id=$1 AND chatbot_id=$2 AND id=$3 FOR UPDATE',values)).rows[0];
      if (!doc) return; // Idempotent and does not reveal another tenant's document.
      if (doc.storage_key) {
        const format = doc.mime_type === 'application/pdf' ? 'pdf' : 'docx';
        // Only canonical private keys may be deleted. Never guess at legacy external locations.
        const {storageKey} = await import('../storage/object-storage.js');
        if (doc.storage_key !== storageKey({...scope,format})) throw new HttpError(409,'STORAGE_RECONCILIATION_REQUIRED','Document storage requires operator reconciliation before deletion.');
        await db.query(`INSERT INTO object_cleanup_jobs(organization_id,chatbot_id,document_id,format,purpose,size_bytes)
          VALUES($1,$2,$3,$4,'delete',$5) ON CONFLICT(document_id) DO NOTHING`,[...values,format,doc.size_bytes??0]);
      }
      await db.query('DELETE FROM documents WHERE organization_id=$1 AND chatbot_id=$2 AND id=$3',values);
      await appendAudit(db,{...audit,...scope,action:'document.deleted',targetType:'document',targetId:scope.documentId});
    });
  }
  async cleanupOne(storage: ObjectStorage) {
    return transaction(this.commercial.pool,async db=>{
      const job = (await db.query('SELECT * FROM object_cleanup_jobs WHERE available_at<=now() ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1')).rows[0];
      if (!job) return false;
      try {
        await storage.delete({organizationId:job.organization_id,chatbotId:job.chatbot_id,documentId:job.document_id,format:job.format});
      } catch {
        await db.query("UPDATE object_cleanup_jobs SET attempts=LEAST(attempts+1,2147483647),available_at=now()+interval '5 minutes' WHERE id=$1",[job.id]);
        return false; // Durable retry, no terminal abandonment and no raw provider error logs.
      }
      await db.query('DELETE FROM object_cleanup_jobs WHERE id=$1',[job.id]);
      return true;
    });
  }
}
