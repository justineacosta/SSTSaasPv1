### Task 8: `packages/storage` — S3-compatible adapter

**Files:**
- Create: `packages/storage/package.json`, `packages/storage/tsconfig.json`, `packages/storage/src/adapter.ts`, `packages/storage/src/keys.ts`, `packages/storage/src/s3-adapter.ts`, `packages/storage/src/index.ts`
- Modify: `.claude/development/folder-structure.md`, `.claude/architecture/overview.md`
- Test: `packages/storage/src/keys.spec.ts`, `packages/storage/src/s3-adapter.integration.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `interface StorageAdapter` — `put`, `get`, `head`, `delete`, `presignGet`, `presignPut`, `list`
  - `interface StoredObjectMetadata { size: number; contentType?: string; etag: string; sha256?: string; lastModified?: Date }`
  - `createS3StorageAdapter(options: S3StorageOptions): StorageAdapter`
  - `tenantPrefix(organizationId: string): string`
  - `evidenceKeyForFinding({ organizationId, findingId, extension, originalFilename? }): string`
  - `evidenceKeyForScan({ organizationId, scanId, extension }): string`
  - `reportKey({ organizationId, reportId, extension }): string`

- [ ] **Step 1: Write the failing key test**

`packages/storage/src/keys.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { evidenceKeyForFinding, evidenceKeyForScan, reportKey, tenantPrefix } from './keys.js';

describe('storage keys', () => {
  it('always begins with the organisation prefix', () => {
    const key = evidenceKeyForFinding({
      organizationId: 'org_01J',
      findingId: 'fnd_01J',
      extension: 'png',
    });
    expect(key.startsWith('org/org_01J/')).toBe(true);
  });

  it('places a finding artifact under its finding', () => {
    const key = evidenceKeyForFinding({
      organizationId: 'org_01J',
      findingId: 'fnd_01J',
      extension: 'png',
    });
    expect(key).toMatch(/^org\/org_01J\/finding\/fnd_01J\/[0-9a-f-]{36}\.png$/);
  });

  it('places a scan artifact under its scan', () => {
    const key = evidenceKeyForScan({
      organizationId: 'org_01J',
      scanId: 'scn_01J',
      extension: 'json',
    });
    expect(key).toMatch(/^org\/org_01J\/scan\/scn_01J\/[0-9a-f-]{36}\.json$/);
  });

  it('builds report keys under the organisation', () => {
    expect(reportKey({ organizationId: 'org_01J', reportId: 'rpt_01J', extension: 'pdf' })).toMatch(
      /^org\/org_01J\/rpt_01J\/[0-9a-f-]{36}\.pdf$/,
    );
  });

  it('never reuses the original filename', () => {
    const key = evidenceKeyForFinding({
      organizationId: 'org_01J',
      findingId: 'fnd_01J',
      extension: 'png',
      originalFilename: '../../etc/passwd',
    });
    expect(key).not.toContain('passwd');
    expect(key).not.toContain('..');
  });

  it('rejects an empty organisation id rather than building a prefix-less key', () => {
    expect(() => tenantPrefix('')).toThrow(/organisation/i);
  });

  it('rejects an extension containing a path separator', () => {
    expect(() =>
      evidenceKeyForFinding({ organizationId: 'org_01J', findingId: 'fnd_01J', extension: '../x' }),
    ).toThrow();
  });

  it('produces a distinct key each call, so keys are not enumerable', () => {
    const args = { organizationId: 'org_01J', findingId: 'fnd_01J', extension: 'png' } as const;
    expect(evidenceKeyForFinding(args)).not.toBe(evidenceKeyForFinding(args));
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

```bash
pnpm vitest run --project unit packages/storage
```
Expected: FAIL — `Cannot find module './keys.js'`.

- [ ] **Step 3: Implement keys**

`packages/storage/src/keys.ts`:
```ts
import { randomUUID } from 'node:crypto';

/**
 * The organisation prefix is what makes a leaked or guessed key harmless: it
 * cannot address another tenant's object, and prefix-scoped IAM policies become
 * possible. This throws rather than returning a prefix-less key, so there is no
 * path to building one by accident. See architecture/storage.md §2.
 */
export function tenantPrefix(organizationId: string): string {
  if (organizationId.trim() === '') {
    throw new Error('Cannot build a storage key without an organisation id.');
  }
  return `org/${organizationId}`;
}

function safeExtension(extension: string): string {
  if (!/^[a-z0-9]{1,10}$/i.test(extension)) {
    throw new Error(`Unsafe storage key extension: ${extension}`);
  }
  return extension.toLowerCase();
}

/**
 * Original filenames are NEVER used in keys — they are stored as object
 * metadata for display only. A user-supplied filename in a key is a path
 * traversal waiting to happen, and it makes keys guessable.
 */
export function evidenceKeyForFinding(options: {
  organizationId: string;
  findingId: string;
  extension: string;
  originalFilename?: string;
}): string {
  const prefix = tenantPrefix(options.organizationId);
  return `${prefix}/finding/${options.findingId}/${randomUUID()}.${safeExtension(options.extension)}`;
}

export function evidenceKeyForScan(options: {
  organizationId: string;
  scanId: string;
  extension: string;
}): string {
  const prefix = tenantPrefix(options.organizationId);
  return `${prefix}/scan/${options.scanId}/${randomUUID()}.${safeExtension(options.extension)}`;
}

export function reportKey(options: {
  organizationId: string;
  reportId: string;
  extension: string;
}): string {
  const prefix = tenantPrefix(options.organizationId);
  return `${prefix}/${options.reportId}/${randomUUID()}.${safeExtension(options.extension)}`;
}
```

- [ ] **Step 4: Implement the adapter interface and the S3 implementation**

`packages/storage/src/adapter.ts`:
```ts
import type { Readable } from 'node:stream';

export interface StoredObjectMetadata {
  readonly size: number;
  readonly contentType?: string;
  readonly etag: string;
  readonly sha256?: string;
  readonly lastModified?: Date;
}

export interface PutOptions {
  readonly contentType?: string;
  /** Stored as object metadata for display. Never used to build the key. */
  readonly originalFilename?: string;
}

export interface PresignGetOptions {
  readonly ttlSeconds: number;
  readonly downloadFilename?: string;
}

export interface KeyPage {
  readonly keys: readonly string[];
  readonly nextCursor: string | null;
}

/**
 * The single interface application code sees. No S3 SDK type crosses this
 * boundary, so the provider is a configuration choice rather than a code
 * dependency. See architecture/storage.md §4.
 */
export interface StorageAdapter {
  put(
    bucket: string,
    key: string,
    body: Buffer | Readable,
    options?: PutOptions,
  ): Promise<{ etag: string; size: number; sha256: string }>;
  get(bucket: string, key: string): Promise<Readable>;
  head(bucket: string, key: string): Promise<StoredObjectMetadata | null>;
  delete(bucket: string, key: string): Promise<void>;
  presignGet(bucket: string, key: string, options: PresignGetOptions): Promise<string>;
  presignPut(bucket: string, key: string, ttlSeconds: number): Promise<string>;
  list(bucket: string, prefix: string, cursor?: string): Promise<KeyPage>;
}
```

`packages/storage/src/s3-adapter.ts`:
```ts
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  KeyPage,
  PresignGetOptions,
  PutOptions,
  StorageAdapter,
  StoredObjectMetadata,
} from './adapter.js';

export interface S3StorageOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

/** Presigned URLs are short-lived and single-purpose. storage.md §3. */
const MAX_PRESIGN_TTL_SECONDS = 300;

async function toBuffer(body: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

export function createS3StorageAdapter(options: S3StorageOptions): StorageAdapter {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: options.forcePathStyle,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  });

  return {
    async put(bucket, key, body, putOptions: PutOptions = {}) {
      const buffer = await toBuffer(body);
      // Computed at upload and stored, so chain of custody can be verified on
      // download for evidence where it matters. storage.md §5.
      const sha256 = createHash('sha256').update(buffer).digest('hex');

      const response = await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: buffer,
          ContentType: putOptions.contentType,
          Metadata: {
            sha256,
            ...(putOptions.originalFilename === undefined
              ? {}
              : { 'original-filename': encodeURIComponent(putOptions.originalFilename) }),
          },
        }),
      );

      return { etag: response.ETag ?? '', size: buffer.byteLength, sha256 };
    },

    async get(bucket, key) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (response.Body === undefined) throw new Error(`Object has no body: ${bucket}/${key}`);
      return response.Body as Readable;
    },

    async head(bucket, key): Promise<StoredObjectMetadata | null> {
      try {
        const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          size: response.ContentLength ?? 0,
          contentType: response.ContentType,
          etag: response.ETag ?? '',
          sha256: response.Metadata?.sha256,
          lastModified: response.LastModified,
        };
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;
        // Absent is null. Anything else — notably 403 — is rethrown, because
        // swallowing it would report a permissions misconfiguration as
        // "missing", which is the hardest kind of bug to find.
        if (status === 404) return null;
        throw error;
      }
    },

    async delete(bucket, key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async presignGet(bucket, key, presignOptions: PresignGetOptions) {
      const filename = (presignOptions.downloadFilename ?? 'download').replaceAll('"', '');
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          // Always attachment, never inline. Evidence rendered inline by a
          // browser is stored XSS against our own users.
          ResponseContentDisposition: `attachment; filename="${filename}"`,
        }),
        { expiresIn: Math.min(presignOptions.ttlSeconds, MAX_PRESIGN_TTL_SECONDS) },
      );
    },

    async presignPut(bucket, key, ttlSeconds) {
      return getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: Math.min(ttlSeconds, MAX_PRESIGN_TTL_SECONDS),
      });
    },

    async list(bucket, prefix, cursor): Promise<KeyPage> {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: cursor,
          MaxKeys: 1000,
        }),
      );
      return {
        keys: (response.Contents ?? []).flatMap((item) =>
          item.Key === undefined ? [] : [item.Key],
        ),
        nextCursor: response.NextContinuationToken ?? null,
      };
    },
  };
}
```

- [ ] **Step 5: Write the MinIO integration test**

`packages/storage/src/s3-adapter.integration.spec.ts`:
```ts
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
```

- [ ] **Step 6: Run both suites**

```bash
pnpm vitest run --project unit packages/storage
pnpm vitest run --project integration packages/storage
```
Expected: unit 8 pass; integration 7 pass.

- [ ] **Step 7: Correct the two documents this deviates from**

In `.claude/development/folder-structure.md`, add to the `packages/` tree block:
```
│   ├── storage/                 S3-compatible adapter, tenant-prefixed keys
```

In `.claude/architecture/overview.md` §3, add the matching line:
```
  storage/          S3-compatible adapter, tenant-prefixed key construction
```

And add one rule to `folder-structure.md` under **Rules**:

> **The storage adapter is a package, not API infrastructure.** Workers upload evidence from
> Phase 5 onward, and no app may import another app, so the adapter has to live where both
> can reach it.

- [ ] **Step 8: Verify and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
git add -A
git commit -m "$(cat <<'EOF'
feat(storage): S3-compatible adapter with non-optional tenant key prefixes

Implements the interface in architecture/storage.md §4, tested against MinIO
in Testcontainers rather than a mock — presign semantics and content-type
handling are precisely what a mock hides.

Key construction cannot produce a key without an organisation prefix: the
builder throws instead. Original filenames never appear in keys. Presigned
GETs always force attachment disposition and are clamped to five minutes,
because evidence rendered inline by a browser is stored XSS against our own
users. head() returns null only for a genuine 404 and rethrows a 403, so a
permissions misconfiguration cannot masquerade as a missing object.

Places the adapter in packages/storage rather than apps/api/src/infrastructure
as folder-structure.md had it: workers need it from Phase 5 and no app may
import another app. Both documents are corrected in this same commit.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

