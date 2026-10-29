import type { EventStoryApi } from '../shared/contracts';

declare global {
  interface Window {
    eventstory: EventStoryApi;
  }
}

export {};
