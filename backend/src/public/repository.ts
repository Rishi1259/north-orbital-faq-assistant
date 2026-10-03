import type { Pool } from 'pg';
import type { z } from 'zod';
import type { BrandingSchema } from '../security/config.js';
import { randomPublicId } from '../security/crypto.js';
import { notFound } from '../security/errors.js';
import { appendAudit, type Audit, SecurityRepository } from '../security/repository.js';

export interface PublicChatbot extends z.infer<typeof BrandingSchema> {
  organizationId: string; chatbotId: string; publicId: string; publicEnabled: boolean;
}
const columns = `organization_id AS "organizationId",id AS "chatbotId",public_id AS "publicId",public_enabled AS "publicEnabled",
  display_name AS "displayName",welcome_message AS "welcomeMessage",accent_color AS "accentColor",
  launcher_label AS "launcherLabel",launcher_position AS "launcherPosition"`;
export function publicConfig(bot: PublicChatbot) {
  return { publicId: bot.publicId, displayName: bot.displayName, welcomeMessage: bot.welcomeMessage,
    accentColor: bot.accentColor, launcherLabel: bot.launcherLabel, launcherPosition: bot.launcherPosition };
}
export class PublicChatbotRepository {
  constructor(private db: Pool, private security: SecurityRepository) {}
  async resolve(publicId: string) {
    if (!/^pub_[a-f0-9]{48}$/.test(publicId)) throw notFound();
    const bot = (await this.db.query<PublicChatbot>(`SELECT ${columns} FROM chatbots WHERE public_id=$1 AND public_enabled=true`, [publicId])).rows[0];
    if (!bot) throw notFound();
    return bot;
  }
  async get(organizationId: string, chatbotId: string) {
    const bot = (await this.db.query<PublicChatbot>(`SELECT ${columns} FROM chatbots WHERE organization_id=$1 AND id=$2`, [organizationId, chatbotId])).rows[0];
    if (!bot) throw notFound(); return bot;
  }
  async origins(organizationId: string, chatbotId: string) {
    await this.get(organizationId, chatbotId);
    return (await this.db.query<{origin: string}>(`SELECT origin FROM chatbot_allowed_origins
      WHERE organization_id=$1 AND chatbot_id=$2 ORDER BY origin`, [organizationId, chatbotId])).rows.map(r => r.origin);
  }
  async update(organizationId: string, chatbotId: string,
    change: { branding?: z.infer<typeof BrandingSchema>; enabled?: boolean; rotate?: boolean; origins?: string[] }, audit: Audit) {
    return this.security.transaction(async db => {
      // Serialize origin replacements and public-state changes on the same chatbot.
      if (!(await db.query('SELECT id FROM chatbots WHERE organization_id=$1 AND id=$2 FOR UPDATE', [organizationId, chatbotId])).rowCount) throw notFound();
      if (change.branding) {
        const b = change.branding;
        await db.query(`UPDATE chatbots SET display_name=$3,welcome_message=$4,accent_color=$5,launcher_label=$6,
          launcher_position=$7,updated_at=now() WHERE organization_id=$1 AND id=$2`,
        [organizationId, chatbotId, b.displayName, b.welcomeMessage, b.accentColor, b.launcherLabel, b.launcherPosition]);
      }
      if (change.enabled !== undefined) await db.query('UPDATE chatbots SET public_enabled=$3,updated_at=now() WHERE organization_id=$1 AND id=$2', [organizationId, chatbotId, change.enabled]);
      if (change.rotate) await db.query('UPDATE chatbots SET public_id=$3,updated_at=now() WHERE organization_id=$1 AND id=$2', [organizationId, chatbotId, randomPublicId()]);
      if (change.origins) {
        await db.query('DELETE FROM chatbot_allowed_origins WHERE organization_id=$1 AND chatbot_id=$2', [organizationId, chatbotId]);
        await db.query(`INSERT INTO chatbot_allowed_origins(organization_id,chatbot_id,origin)
          SELECT $1,$2,unnest($3::text[])`, [organizationId, chatbotId, change.origins]);
      }
      await appendAudit(db, { ...audit, organizationId, chatbotId, targetId: chatbotId });
      return (await db.query<PublicChatbot>(`SELECT ${columns} FROM chatbots WHERE organization_id=$1 AND id=$2`, [organizationId, chatbotId])).rows[0];
    });
  }
}
