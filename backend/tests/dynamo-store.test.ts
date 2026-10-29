import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, expect, it, vi } from 'vitest';
import type { RequestRecord } from '../src/app';
import { DynamoStore } from '../src/dynamo-store';

afterEach(() => vi.restoreAllMocks());
function mockStore(send: ReturnType<typeof vi.fn>) {
  vi.spyOn(DynamoDBDocumentClient, 'from').mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
  return new DynamoStore('pilot-table');
}
const rec: RequestRecord = { requestId: 'id', userId: 'u1', imageSha256: 'sha', status: 'reserving', createdAt: 100, ttl: 200, owner: 'owner-uuid' };

it('recognises its own successful Put after an SDK retry loses the first response', async () => {
  const send = vi.fn()
    .mockRejectedValueOnce(Object.assign(new Error(), { name: 'ConditionalCheckFailedException' }))
    .mockResolvedValueOnce({ Item: { pk: 'REQ#id', ...rec } });
  expect(await mockStore(send).createRequest(rec)).toBe('created');
});

it('fences takeover on the observed owner and status, not only a timestamp', async () => {
  const send = vi.fn().mockResolvedValue({});
  await mockStore(send).replaceRequest({ ...rec, owner: 'new-owner' }, rec);
  const input = send.mock.calls[0]![0].input;
  expect(input.ConditionExpression).toContain('#s = :status');
  expect(input.ConditionExpression).toContain('#o = :owner');
  expect(input.ExpressionAttributeValues[':owner']).toBe(rec.owner);
});

it('reserves with an idempotent transaction token and releases only its own reservation', async () => {
  const send = vi.fn().mockResolvedValue({});
  const store = mockStore(send);
  expect(await store.reserveQuota({ requestId: 'id', userId: 'u1', owner: 'owner-uuid', month: '2026-10', globalLimit: 4000, userLimit: 1000 })).toBe('ok');
  const input = send.mock.calls[0]![0].input;
  expect(input.ClientRequestToken).toBe('owner-uuid');
  expect(input.TransactItems[2].Update.ConditionExpression).toContain('#o = :owner');
  await store.releaseReservation('id', 'owner-uuid');
  expect(send.mock.calls[1]![0].input.ConditionExpression).toContain('#o = :owner');
});
