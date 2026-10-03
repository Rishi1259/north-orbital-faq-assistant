export class OrganizationNotFoundError
  extends Error {
  constructor() {
    super(
      'Organization not found.',
    );

    this.name =
      'OrganizationNotFoundError';
  }
}

export class OrganizationSlugTakenError
  extends Error {
  constructor() {
    super(
      'Organization slug is already in use.',
    );

    this.name =
      'OrganizationSlugTakenError';
  }
}

export class ChatbotNotFoundError
  extends Error {
  constructor() {
    super(
      'Chatbot not found.',
    );

    this.name =
      'ChatbotNotFoundError';
  }
}