import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { AnalysisResult, QuotaResult, RequestRecord, Store, TokenRecord } from './app';

const QUOTA_TTL_SECONDS = 400 * 24 * 3600;

/**
 * Single-table DynamoDB store (partition key `pk`, TTL attribute `ttl`).
 *   TOKEN#<sha256>           token record (no plain token is ever stored)
 *   QUOTA#GLOBAL#<yyyy-mm>    shared monthly usage
 *   QUOTA#USER#<id>#<yyyy-mm> personal monthly usage
 *   REQ#<requestId>           idempotency record + analysis result (no image)
 */
export class DynamoStore implements Store {
  private readonly doc: DynamoDBDocumentClient;
  constructor(
    private readonly table: string,
    client = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async getToken(hash: string): Promise<TokenRecord | null> {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: `TOKEN#${hash}` }, ConsistentRead: true }));
    if (!r.Item) return null;
    return { userId: r.Item.userId, label: r.Item.label, active: r.Item.active === true, userMonthlyLimit: Number(r.Item.userMonthlyLimit) };
  }

  async createRequest(rec: RequestRecord): Promise<'created' | 'exists'> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { pk: `REQ#${rec.requestId}`, ...rec },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return 'created';
    } catch (e) {
      if ((e as Error).name !== 'ConditionalCheckFailedException') throw e;
      // The SDK may have retried a Put whose first attempt succeeded: recognise our own write.
      const existing = await this.getRequest(rec.requestId);
      return existing && rec.owner && existing.owner === rec.owner ? 'created' : 'exists';
    }
  }

  async replaceRequest(rec: RequestRecord, previous: RequestRecord): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { pk: `REQ#${rec.requestId}`, ...rec },
          ConditionExpression: `createdAt = :prev AND #s = :status AND ${previous.owner ? '#o = :owner' : 'attribute_not_exists(#o)'}`,
          ExpressionAttributeNames: { '#s': 'status', '#o': 'owner' },
          ExpressionAttributeValues: { ':prev': previous.createdAt, ':status': previous.status, ...(previous.owner ? { ':owner': previous.owner } : {}) },
        }),
      );
      return true;
    } catch (e) {
      if ((e as Error).name !== 'ConditionalCheckFailedException') throw e;
      const existing = await this.getRequest(rec.requestId);
      return !!existing && existing.owner === rec.owner;
    }
  }

  async abandonRequest(id: string, ttl: number, createdAt: number): Promise<void> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: `REQ#${id}` },
          UpdateExpression: 'SET #s = :failed, errorCode = :code, #ttl = :ttl',
          ConditionExpression: '#s = :processing AND createdAt = :createdAt',
          ExpressionAttributeNames: { '#s': 'status', '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':failed': 'failed', ':code': 'ABANDONED', ':ttl': ttl, ':processing': 'processing', ':createdAt': createdAt },
        }),
      );
    } catch (e) {
      if ((e as Error).name !== 'ConditionalCheckFailedException') throw e;
    }
  }

  async getRequest(id: string): Promise<RequestRecord | null> {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: `REQ#${id}` }, ConsistentRead: true }));
    if (!r.Item) return null;
    const { pk: _pk, ...rest } = r.Item;
    return rest as RequestRecord;
  }

  async reserveQuota(a: { requestId: string; userId: string; owner: string; month: string; globalLimit: number; userLimit: number }): Promise<QuotaResult> {
    const ttl = Math.floor(Date.now() / 1000) + QUOTA_TTL_SECONDS;
    const inc = (pk: string, limit: number) => ({
      Update: {
        TableName: this.table,
        Key: { pk },
        UpdateExpression: 'SET used = if_not_exists(used, :zero) + :one, #ttl = :ttl',
        ConditionExpression: 'attribute_not_exists(used) OR used < :limit',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':limit': limit, ':ttl': ttl },
      },
    });
    try {
      await this.doc.send(
        new TransactWriteCommand({
          ClientRequestToken: a.owner,
          TransactItems: [
            inc(`QUOTA#GLOBAL#${a.month}`, a.globalLimit),
            inc(`QUOTA#USER#${a.userId}#${a.month}`, a.userLimit),
            {
              Update: {
                TableName: this.table,
                Key: { pk: `REQ#${a.requestId}` },
                UpdateExpression: 'SET #s = :processing',
                ConditionExpression: '#s = :reserving AND #o = :owner',
                ExpressionAttributeNames: { '#s': 'status', '#o': 'owner' },
                ExpressionAttributeValues: { ':processing': 'processing', ':reserving': 'reserving', ':owner': a.owner },
              },
            },
          ],
        }),
      );
      return 'ok';
    } catch (e) {
      if (e instanceof TransactionCanceledException || (e as Error).name === 'TransactionCanceledException') {
        const reasons = (e as TransactionCanceledException).CancellationReasons ?? [];
        if (reasons[0]?.Code === 'ConditionalCheckFailed') return 'global-exhausted';
        if (reasons[1]?.Code === 'ConditionalCheckFailed') return 'user-exhausted';
        return 'conflict';
      }
      throw e;
    }
  }

  async releaseReservation(id: string, owner: string): Promise<void> {
    try {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.table,
          Key: { pk: `REQ#${id}` },
          ConditionExpression: '#s = :reserving AND #o = :owner',
          ExpressionAttributeNames: { '#s': 'status', '#o': 'owner' },
          ExpressionAttributeValues: { ':reserving': 'reserving', ':owner': owner },
        }),
      );
    } catch (e) {
      if ((e as Error).name !== 'ConditionalCheckFailedException') throw e;
    }
  }

  async completeRequest(id: string, result: AnalysisResult, ttl: number, owner: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: `REQ#${id}` },
        UpdateExpression: 'SET #s = :done, #r = :result, #ttl = :ttl',
        ConditionExpression: '#o = :owner',
        ExpressionAttributeNames: { '#s': 'status', '#r': 'result', '#ttl': 'ttl', '#o': 'owner' },
        ExpressionAttributeValues: { ':done': 'done', ':result': result, ':ttl': ttl, ':owner': owner },
      }),
    );
  }

  async failRequest(id: string, errorCode: string, ttl: number, owner: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: `REQ#${id}` },
        UpdateExpression: 'SET #s = :failed, errorCode = :code, #ttl = :ttl',
        ConditionExpression: '#o = :owner',
        ExpressionAttributeNames: { '#s': 'status', '#ttl': 'ttl', '#o': 'owner' },
        ExpressionAttributeValues: { ':failed': 'failed', ':code': errorCode, ':ttl': ttl, ':owner': owner },
      }),
    );
  }

  async getQuota(userId: string, month: string): Promise<{ globalUsed: number; userUsed: number }> {
    const [g, u] = await Promise.all([
      this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: `QUOTA#GLOBAL#${month}` }, ConsistentRead: true })),
      this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: `QUOTA#USER#${userId}#${month}` }, ConsistentRead: true })),
    ]);
    return { globalUsed: Number(g.Item?.used ?? 0), userUsed: Number(u.Item?.used ?? 0) };
  }
}
