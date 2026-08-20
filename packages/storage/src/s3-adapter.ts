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
        // exactOptionalPropertyTypes forbids assigning `undefined` to an
        // optional property outright — each optional field is only present
        // when the SDK actually returned a value.
        return {
          size: response.ContentLength ?? 0,
          etag: response.ETag ?? '',
          ...(response.ContentType === undefined ? {} : { contentType: response.ContentType }),
          ...(response.Metadata?.sha256 === undefined ? {} : { sha256: response.Metadata.sha256 }),
          ...(response.LastModified === undefined ? {} : { lastModified: response.LastModified }),
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
