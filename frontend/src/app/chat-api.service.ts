import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { timeout } from 'rxjs';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatSource {
  id: string;
  title: string;
  path: string;
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

  sendChat(request: ChatRequest) {
    return this.http
      .post<ChatResponse>('/api/chat', request)
      .pipe(timeout(35_000));
  }
}
