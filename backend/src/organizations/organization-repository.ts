import type {
  Pool,
} from 'pg';

import type {
  CreateOrganizationInput,
  Organization,
} from './types.js';

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  created_at: Date;
  updated_at: Date;
}

function mapOrganization(
  row: OrganizationRow,
): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt:
      row.created_at,
    updatedAt:
      row.updated_at,
  };
}

export class OrganizationRepository {
  constructor(
    private readonly database: Pool,
  ) {}

  async create(
    input: CreateOrganizationInput,
  ): Promise<Organization> {
    const result =
      await this.database.query<OrganizationRow>(
        `
          INSERT INTO organizations (
            name,
            slug
          )
          VALUES ($1, $2)
          RETURNING
            id,
            name,
            slug,
            created_at,
            updated_at
        `,
        [
          input.name,
          input.slug,
        ],
      );

    return mapOrganization(
      result.rows[0],
    );
  }

  async findById(
    id: string,
  ): Promise<Organization | null> {
    const result =
      await this.database.query<OrganizationRow>(
        `
          SELECT
            id,
            name,
            slug,
            created_at,
            updated_at
          FROM organizations
          WHERE id = $1
        `,
        [id],
      );

    const row =
      result.rows[0];

    return row
      ? mapOrganization(row)
      : null;
  }

  async findBySlug(
    slug: string,
  ): Promise<Organization | null> {
    const result =
      await this.database.query<OrganizationRow>(
        `
          SELECT
            id,
            name,
            slug,
            created_at,
            updated_at
          FROM organizations
          WHERE slug = $1
        `,
        [slug],
      );

    const row =
      result.rows[0];

    return row
      ? mapOrganization(row)
      : null;
  }
}