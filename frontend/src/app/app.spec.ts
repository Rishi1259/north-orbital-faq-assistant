import { provideHttpClient } from '@angular/common/http';
import {
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
  });

  it('creates the application', () => {
    const fixture =
      TestBed.createComponent(App);

    expect(fixture.componentInstance)
      .toBeTruthy();
  });

  it('starts with the fictional nonprofit welcome message', () => {
    const fixture =
      TestBed.createComponent(App);

    const app = fixture.componentInstance;

    expect(app.messages()).toHaveLength(1);
    expect(app.messages()[0]?.content)
      .toContain('fictional North Orbital');
  });

  it('clears conversation history when restarted', () => {
    const fixture =
      TestBed.createComponent(App);

    const app = fixture.componentInstance;

    app.draft.set('temporary text');
    app.restartConversation();

    expect(app.draft()).toBe('');
    expect(app.messages()).toHaveLength(1);
  });
});
