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
