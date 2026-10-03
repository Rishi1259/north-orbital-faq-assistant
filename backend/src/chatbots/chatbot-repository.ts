import type {
  Pool,
} from 'pg';

import type {
  Chatbot,
  ChatbotStatus,
  CreateChatbotInput,
} from './types.js';

interface ChatbotRow {
  id: string;
  organization_id: string;
  name: string;
  status: ChatbotStatus;
  created_at: Date;
  updated_at: Date;
}

function mapChatbot(
  row: ChatbotRow,
): Chatbot {
  return {
    id: row.id,

    organizationId:
      row.organization_id,

    name:
      row.name,

    status:
      row.status,

    createdAt:
      row.created_at,

    updatedAt:
      row.updated_at,
  };
}

export class ChatbotRepository {
  constructor(
    private readonly database: Pool,
  ) {}

  async create(
    input: CreateChatbotInput,
  ): Promise<Chatbot> {
    const result =
      await this.database.query<ChatbotRow>(
        `
          INSERT INTO chatbots (
            organization_id,
            name
          )
          VALUES ($1, $2)
          RETURNING
            id,
            organization_id,
            name,
            status,
            created_at,
            updated_at
        `,
        [
          input.organizationId,
          input.name,
        ],
      );

    return mapChatbot(
      result.rows[0],
    );
  }

  async findById(
    organizationId: string,
    chatbotId: string,
  ): Promise<Chatbot | null> {
    const result =
      await this.database.query<ChatbotRow>(
        `
          SELECT
            id,
            organization_id,
            name,
            status,
            created_at,
            updated_at
          FROM chatbots
          WHERE
            id = $1
            AND organization_id = $2
        `,
        [
          chatbotId,
          organizationId,
        ],
      );

    const row =
      result.rows[0];

    return row
      ? mapChatbot(row)
      : null;
  }

  async listByOrganization(
    organizationId: string,
  ): Promise<Chatbot[]> {
    const result =
      await this.database.query<ChatbotRow>(
        `
          SELECT
            id,
            organization_id,
            name,
            status,
            created_at,
            updated_at
          FROM chatbots
          WHERE organization_id = $1
          ORDER BY created_at ASC
        `,
        [
          organizationId,
        ],
      );

    return result.rows.map(
      mapChatbot,
    );
  }
}