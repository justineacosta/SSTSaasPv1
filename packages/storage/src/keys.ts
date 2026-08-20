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
