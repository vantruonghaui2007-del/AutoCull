#!/usr/bin/env node
// Pilot token administration. Uses your local AWS profile (AWS_PROFILE) — run it yourself.
//   node scripts/token.mjs create --label "Pilot 1" [--limit 1000]   prints the token ONCE
//   node scripts/token.mjs list
//   node scripts/token.mjs revoke --label "Pilot 1"
//   node scripts/token.mjs set-limit --label "Pilot 1" --limit 500
//   node scripts/token.mjs usage
// Table: --table <name> or the TableName output of stack --stack (default eventstory-cull-pilot).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const MAX_PILOT_USERS = 5;
const hashToken = (t) => createHash('sha256').update(`eventstory-token:${t}`).digest('hex');

function tableName() {
  if (opt('table')) return opt('table');
  const stack = opt('stack', 'eventstory-cull-pilot');
  const out = execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue", '--output', 'text'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }).trim();
  if (!out || out === 'None') throw new Error(`Không đọc được TableName từ stack ${stack}`);
  return out;
}

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const table = tableName();
// Tokens share the table with request records: follow every page of the scan.
const tokens = async () => {
  const items = [];
  let start;
  do {
    const r = await doc.send(
      new ScanCommand({ TableName: table, FilterExpression: 'begins_with(pk, :p)', ExpressionAttributeValues: { ':p': 'TOKEN#' }, ExclusiveStartKey: start }),
    );
    items.push(...(r.Items ?? []));
    start = r.LastEvaluatedKey;
  } while (start);
  return items;
};
const byLabel = async (label) => {
  const t = (await tokens()).find((x) => x.label === label);
  if (!t) throw new Error(`Không có token nhãn "${label}"`);
  return t;
};
const month = new Date().toISOString().slice(0, 7);

if (cmd === 'create') {
  const label = opt('label');
  if (!label) throw new Error('--label là bắt buộc');
  const existing = await tokens();
  if (existing.filter((t) => t.active).length >= MAX_PILOT_USERS) throw new Error(`Pilot giới hạn ${MAX_PILOT_USERS} người đang hoạt động.`);
  if (existing.some((t) => t.label === label)) throw new Error(`Nhãn "${label}" đã tồn tại`);
  const token = randomBytes(32).toString('base64url');
  const limit = Number(opt('limit', 1000));
  await doc.send(
    new PutCommand({
      TableName: table,
      Item: { pk: `TOKEN#${hashToken(token)}`, userId: `u_${randomUUID()}`, label, active: true, userMonthlyLimit: limit, createdAt: new Date().toISOString() },
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );
  console.log(`Đã tạo token cho "${label}" (quota ${limit}/tháng). Token chỉ hiện MỘT lần, hãy chuyển riêng cho người dùng:\n\n${token}\n`);
} else if (cmd === 'list') {
  for (const t of await tokens()) console.log(`${t.label}\t${t.active ? 'hoạt động' : 'đã thu hồi'}\tquota ${t.userMonthlyLimit}\t${t.userId}\t${t.createdAt}`);
} else if (cmd === 'revoke') {
  const t = await byLabel(opt('label'));
  await doc.send(new UpdateCommand({ TableName: table, Key: { pk: t.pk }, UpdateExpression: 'SET active = :f, revokedAt = :at', ExpressionAttributeValues: { ':f': false, ':at': new Date().toISOString() } }));
  console.log(`Đã thu hồi "${t.label}".`);
} else if (cmd === 'set-limit') {
  const t = await byLabel(opt('label'));
  const limit = Number(opt('limit'));
  if (!Number.isInteger(limit) || limit < 0) throw new Error('--limit phải là số nguyên ≥ 0');
  await doc.send(new UpdateCommand({ TableName: table, Key: { pk: t.pk }, UpdateExpression: 'SET userMonthlyLimit = :l', ExpressionAttributeValues: { ':l': limit } }));
  console.log(`"${t.label}": quota ${limit}/tháng.`);
} else if (cmd === 'usage') {
  const g = await doc.send(new GetCommand({ TableName: table, Key: { pk: `QUOTA#GLOBAL#${month}` } }));
  console.log(`Tháng ${month} — dùng chung: ${g.Item?.used ?? 0}`);
  for (const t of await tokens()) {
    const u = await doc.send(new GetCommand({ TableName: table, Key: { pk: `QUOTA#USER#${t.userId}#${month}` } }));
    console.log(`  ${t.label}: ${u.Item?.used ?? 0}/${t.userMonthlyLimit}`);
  }
} else {
  console.log('Lệnh: create | list | revoke | set-limit | usage');
  process.exit(2);
}
