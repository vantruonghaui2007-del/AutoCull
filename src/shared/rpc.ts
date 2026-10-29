import type { ProgressEvent, Result } from './contracts';
import type { LocalInference } from './local-analysis';

/** Messages between main and the worker utility process. */
export interface WorkerRequest {
  id: number;
  method: string;
  params: unknown[];
}
export interface WorkerResponse {
  id: number;
  result: Result<unknown>;
}
export interface WorkerEventMessage {
  event: ProgressEvent;
}
export type LocalDetectRequest = { localDetect: number; jpeg: Uint8Array };
export type LocalDetectResponse = { localResult: number; result: Result<LocalInference> };
export type WorkerMessage = WorkerResponse | WorkerEventMessage | { ready: true } | LocalDetectRequest;

export const IPC_PREFIX = 'es:';
export const PROGRESS_CHANNEL = 'es:progress';
