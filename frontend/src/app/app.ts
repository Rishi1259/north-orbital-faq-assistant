import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  inject,
  signal,
} from '@angular/core';
import {
  Subscription,
  TimeoutError,
} from 'rxjs';

import {
  ChatApiService,
  type ChatMessage,
  type ChatSource,
} from './chat-api.service';

import {
  CHATBOT_CONTEXT,
} from './chatbot-context';

interface UiMessage extends ChatMessage {
  id: number;
  sources: ChatSource[];
  fallback: boolean;
  error: boolean;
  includeInHistory: boolean;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly chatApi = inject(ChatApiService);

  private nextMessageId = 1;
  private activeRequest?: Subscription;

  readonly messages = signal<UiMessage[]>([]);
  readonly draft = signal('');
  readonly loading = signal(false);

  constructor() {
    this.restartConversation();
  }

  updateDraft(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.draft.set(target.value);
  }

  handleKeydown(event: KeyboardEvent): void {
    if (
      event.key === 'Enter' &&
      !event.shiftKey
    ) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  sendMessage(): void {
    const message = this.draft().trim();

    if (!message || this.loading()) {
      return;
    }

    const history: ChatMessage[] =
      this.messages()
        .filter(
          (item) => item.includeInHistory,
        )
        .slice(-6)
        .map((item) => ({
          role: item.role,
          content: item.content,
        }));

    this.appendMessage({
      role: 'user',
      content: message,
      sources: [],
      fallback: false,
      error: false,
      includeInHistory: true,
    });

    this.draft.set('');
    this.loading.set(true);

    this.activeRequest =
      this.chatApi
  .sendChat(
    CHATBOT_CONTEXT.organizationId,
    CHATBOT_CONTEXT.chatbotId,
    {
      message,
      history,
    },
  )
        .subscribe({
          next: (response) => {
            this.appendMessage({
              role: 'assistant',
              content: response.answer,
              sources: response.sources,
              fallback: response.fallback,
              error: false,
              includeInHistory: true,
            });

            this.loading.set(false);
            this.activeRequest = undefined;
          },

          error: (error: unknown) => {
            this.appendMessage({
              role: 'assistant',
              content:
                this.getFriendlyError(error),
              sources: [],
              fallback: false,
              error: true,
              includeInHistory: false,
            });

            this.loading.set(false);
            this.activeRequest = undefined;
          },
        });
  }

  restartConversation(): void {
    this.activeRequest?.unsubscribe();
    this.activeRequest = undefined;

    this.loading.set(false);
    this.draft.set('');

    this.messages.set([
      {
        id: this.nextMessageId++,
        role: 'assistant',
        content:
          'Hi! I can answer questions about the fictional North Orbital Community Initiative. Ask me about workshops, registration, accessibility, technology access, volunteering, opening hours, or other information in the demo knowledge base.',
        sources: [],
        fallback: false,
        error: false,
        includeInHistory: false,
      },
    ]);
  }

  sourceHref(source: ChatSource): string {
    return `/api${source.path}`;
  }

  private appendMessage(
    message: Omit<UiMessage, 'id'>,
  ): void {
    this.messages.update((current) => [
      ...current,
      {
        ...message,
        id: this.nextMessageId++,
      },
    ]);
  }

  private getFriendlyError(
    error: unknown,
  ): string {
    if (error instanceof TimeoutError) {
      return 'The request took too long. Please try again.';
    }

    if (error instanceof HttpErrorResponse) {
      const backendCode =
        error.error?.error?.code as string | undefined;

      switch (backendCode) {
        case 'CHATBOT_NOT_FOUND':
          return 'This chatbot is unavailable or could not be found.';

        case 'INVALID_REQUEST':
          return 'That message could not be processed. Please shorten or rephrase it and try again.';

        case 'RATE_LIMITED':
          return 'There have been too many requests in a short period. Please try again shortly.';

        case 'MODEL_INVALID_RESPONSE':
          return 'The AI model returned an invalid response. Please try again.';

        case 'MODEL_UNAVAILABLE':
          return 'The local AI model is unavailable. Make sure Ollama is running and try again.';

        case 'MODEL_TIMEOUT':
          return 'The local AI model took too long to respond. Please try again.';
      }

      switch (error.status) {
        case 0:
          return 'I could not reach the FAQ server. Make sure the backend is running and try again.';

        case 400:
          return 'That message could not be processed. Please shorten or rephrase it and try again.';

        case 429:
          return 'There have been too many requests in a short period. Please try again shortly.';

        case 502:
          return 'The AI model returned an invalid response. Please try again.';

        case 503:
          return 'The local AI model is unavailable. Make sure Ollama is running and try again.';

        case 504:
          return 'The local AI model took too long to respond. Please try again.';

        default:
          if (error.status >= 500) {
            return 'I could not reach the FAQ server or the server encountered an error. Please make sure the backend is running and try again.';
          }
      }
    }

    return 'Something unexpected went wrong. Please try again.';
  }
}
