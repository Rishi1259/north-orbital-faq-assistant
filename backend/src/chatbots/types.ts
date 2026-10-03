export type ChatbotStatus =
  | 'draft'
  | 'active'
  | 'disabled';

export interface Chatbot {
  id: string;
  organizationId: string;
  name: string;
  status: ChatbotStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateChatbotInput {
  organizationId: string;
  name: string;
}