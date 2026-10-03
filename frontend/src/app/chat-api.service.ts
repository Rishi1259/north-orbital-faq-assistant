import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { timeout } from 'rxjs';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatSource {
  id: string;
  kind: 'faq' | 'document';
  title: string;
  path: string;
  location?: string;
}

export interface ChatResponse {
  answer: string;
  sources: ChatSource[];
  fallback: boolean;
}

export interface ChatRequest {
  message: string;
  history: ChatMessage[];
}

@Injectable({
  providedIn: 'root',
})
export class ChatApiService {
  private readonly http = inject(HttpClient);

  sendChat(
  organizationId: string,
  chatbotId: string,
  request: ChatRequest,
) {
  const url =
    `/api/organizations/${encodeURIComponent(
      organizationId,
    )}/chatbots/${encodeURIComponent(
      chatbotId,
    )}/chat`;

  return this.http
    .post<ChatResponse>(
      url,
      request,
    )
    .pipe(timeout(110_000));
}
}
