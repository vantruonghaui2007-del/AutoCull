import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { handle, type AppConfig } from './app';
import { DynamoStore } from './dynamo-store';
import { RekognitionProvider } from './rekognition';

const store = new DynamoStore(process.env.TABLE_NAME!);
const provider = new RekognitionProvider();
const config: AppConfig = {
  globalMonthlyLimit: Number(process.env.GLOBAL_MONTHLY_LIMIT ?? 4000),
  maxImageBytes: Number(process.env.MAX_IMAGE_BYTES ?? 2.5 * 1024 * 1024),
  resultTtlHours: Number(process.env.RESULT_TTL_HOURS ?? 24),
  now: () => Date.now(),
};

/** Lambda Function URL entry point. Logs carry no image, token or face data. */
export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const started = Date.now();
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) headers[k.toLowerCase()] = v;
  const body = event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8') : Buffer.alloc(0);
  let status = 500;
  let payload: unknown = { error: 'INTERNAL', message: 'Lỗi máy chủ.' };
  try {
    const r = await handle({ method: event.requestContext.http.method, path: event.rawPath, headers, body }, { store, provider, config });
    status = r.status;
    payload = r.body;
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', name: (e as Error)?.name, path: event.rawPath }));
  }
  console.log(JSON.stringify({ path: event.rawPath, method: event.requestContext.http.method, status, ms: Date.now() - started, bytes: body.length }));
  return { statusCode: status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(payload) };
}
