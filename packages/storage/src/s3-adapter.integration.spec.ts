import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { createS3StorageAdapter } from './s3-adapter.js';
import { evidenceKeyForFinding } from './keys.js';
import type { StorageAdapter } from './adapter.js';

const BUCKET = 'evidence';
const ACCESS_KEY = 'test_key';
const SECRET_KEY = 'test_secret_key';

let container: StartedTestContainer;
let storage: StorageAdapter;

beforeAll(async () => {
  container = await new GenericContainer('minio/minio:latest')
    .withCommand(['server', '/data'])
    .withEnvironment({ MINIO_ROOT_USER: ACCESS_KEY, MINIO_ROOT_PASSWORD: SECRET_KEY })
    .withExposedPorts(9000)
    .start();

  const endpoint = `http://${container.getHost()}:${String(container.getMappedPort(9000))}`;
  const credentials = { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY };

  await new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials }).send(
    new CreateBucketCommand({ Bucket: BUCKET }),
  );

  storage = createS3StorageAdapter({
    endpoint,
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    forcePathStyle: true,
  });
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

const key = (): string =>
  evidenceKeyForFinding({ organizationId: 'org_01J', findingId: 'fnd_01J', extension: 'txt' });

describe('S3 storage adapter against MinIO', () => {
  it('round-trips an object and reports its SHA-256', async () => {
    const objectKey = key();
    const body = Buffer.from('HTTP/1.1 200 OK\r\n\r\nhello');
    const result = await storage.put(BUCKET, objectKey, body, { contentType: 'text/plain' });

    expect(result.size).toBe(body.byteLength);
    expect(result.sha256).toBe(createHash('sha256').update(body).digest('hex'));

    const chunks: Buffer[] = [];
    for await (const chunk of await storage.get(BUCKET, objectKey)) {
      chunks.push(Buffer.from(chunk as Buffer));
    }
    expect(Buffer.concat(chunks).toString()).toBe(body.toString());
  });

  it('returns null from head for an absent object', async () => {
    expect(await storage.head(BUCKET, key())).toBeNull();
  });

  it('returns metadata including the stored hash', async () => {
    const objectKey = key();
    const { sha256 } = await storage.put(BUCKET, objectKey, Buffer.from('x'));
    const metadata = await storage.head(BUCKET, objectKey);
    expect(metadata?.size).toBe(1);
    expect(metadata?.sha256).toBe(sha256);
  });

  it('deletes an object', async () => {
    const objectKey = key();
    await storage.put(BUCKET, objectKey, Buffer.from('x'));
    await storage.delete(BUCKET, objectKey);
    expect(await storage.head(BUCKET, objectKey)).toBeNull();
  });

  it('issues a presigned GET that forces attachment disposition', async () => {
    const objectKey = key();
    await storage.put(BUCKET, objectKey, Buffer.from('x'));
    const url = await storage.presignGet(BUCKET, objectKey, {
      ttlSeconds: 300,
      downloadFilename: 'evidence.txt',
    });
    expect(url).toContain('X-Amz-Signature');
    expect(decodeURIComponent(url)).toContain('attachment; filename="evidence.txt"');
  });

  it('clamps a too-long presign TTL to five minutes', async () => {
    const objectKey = key();
    await storage.put(BUCKET, objectKey, Buffer.from('x'));
    const url = await storage.presignGet(BUCKET, objectKey, { ttlSeconds: 86_400 });
    expect(url).toContain('X-Amz-Expires=300');
  });

  it('lists by tenant prefix and does not cross organisations', async () => {
    await storage.put(
      BUCKET,
      evidenceKeyForFinding({ organizationId: 'org_A', findingId: 'fnd_1', extension: 'txt' }),
      Buffer.from('a'),
    );
    await storage.put(
      BUCKET,
      evidenceKeyForFinding({ organizationId: 'org_B', findingId: 'fnd_2', extension: 'txt' }),
      Buffer.from('b'),
    );
    const page = await storage.list(BUCKET, 'org/org_A/');
    expect(page.keys).toHaveLength(1);
    expect(page.keys[0]).toContain('org/org_A/');
  });
});
