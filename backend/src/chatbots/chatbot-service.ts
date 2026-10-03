import {
  z,
} from 'zod';

import {
  OrganizationNotFoundError,
} from '../organizations/errors.js';

import {
  OrganizationRepository,
} from '../organizations/organization-repository.js';

import {
  ChatbotNotFoundError,
} from './errors.js';

import {
  ChatbotRepository,
} from './chatbot-repository.js';

const IdSchema =
  z.uuid();

const CreateChatbotSchema =
  z.object({
    name:
      z
        .string()
        .trim()
        .min(1)
        .max(120),
  });

export class ChatbotService {
  constructor(
    private readonly organizations:
      OrganizationRepository,

    private readonly chatbots:
      ChatbotRepository,
  ) {}

  async create(
    organizationId: unknown,
    input: unknown,
  ) {
    const id =
      IdSchema.parse(
        organizationId,
      );

    const parsed =
      CreateChatbotSchema.parse(
        input,
      );

    const organization =
      await this.organizations
        .findById(id);

    if (!organization) {
      throw new OrganizationNotFoundError();
    }

    return this.chatbots.create({
      organizationId:
        organization.id,

      name:
        parsed.name,
    });
  }

  async getById(
    organizationId: unknown,
    chatbotId: unknown,
  ) {
    const orgId =
      IdSchema.parse(
        organizationId,
      );

    const botId =
      IdSchema.parse(
        chatbotId,
      );

    const chatbot =
      await this.chatbots
        .findById(
          orgId,
          botId,
        );

    if (!chatbot) {
      throw new ChatbotNotFoundError();
    }

    return chatbot;
  }

  async listByOrganization(
    organizationId: unknown,
  ) {
    const id =
      IdSchema.parse(
        organizationId,
      );

    const organization =
      await this.organizations
        .findById(id);

    if (!organization) {
      throw new OrganizationNotFoundError();
    }

    return this.chatbots
      .listByOrganization(id);
  }
}