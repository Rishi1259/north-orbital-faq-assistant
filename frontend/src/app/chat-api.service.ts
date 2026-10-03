import { publicApiOrigin } from './chatbot-context';
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

  source(publicId: string, sourceId: string) {
    return this.http.get<{ excerpt: string }>(`${publicApiOrigin()}/api/public/chatbots/${encodeURIComponent(publicId)}/document-sources/${encodeURIComponent(sourceId)}`);
  }
  sendChat(publicId: string, request: ChatRequest) {
    return this.http.post<ChatResponse>(`${publicApiOrigin()}/api/public/chatbots/${encodeURIComponent(publicId)}/chat`, request)
      .pipe(timeout(110_000));
  }
}
