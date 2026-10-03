import {
  z,
} from 'zod';

import {
  OrganizationNotFoundError,
  OrganizationSlugTakenError,
} from './errors.js';

import {
  OrganizationRepository,
} from './organization-repository.js';

const OrganizationIdSchema =
  z.uuid();

const CreateOrganizationSchema =
  z.object({
    name:
      z
        .string()
        .trim()
        .min(1)
        .max(120),

    slug:
      z
        .string()
        .trim()
        .min(2)
        .max(80)
        .regex(
          /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
          'Slug must contain lowercase letters, numbers, and hyphens only.',
        ),
  });

export class OrganizationService {
  constructor(
    private readonly organizations:
      OrganizationRepository,
  ) {}

  async create(
    input: unknown,
  ) {
    const parsed =
      CreateOrganizationSchema.parse(
        input,
      );

    const existing =
      await this.organizations
        .findBySlug(
          parsed.slug,
        );

    if (existing) {
      throw new OrganizationSlugTakenError();
    }

    return this.organizations.create(
      parsed,
    );
  }

  async getById(
    organizationId: unknown,
  ) {
    const id =
      OrganizationIdSchema.parse(
        organizationId,
      );

    const organization =
      await this.organizations
        .findById(id);

    if (!organization) {
      throw new OrganizationNotFoundError();
    }

    return organization;
  }
}