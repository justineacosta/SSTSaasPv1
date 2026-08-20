export const SYSTEM_ROLES = [
  'OWNER',
  'ADMIN',
  'SECURITY_LEAD',
  'MEMBER',
  'VIEWER',
  'AUDITOR',
  'GUEST',
] as const;

export type SystemRole = (typeof SYSTEM_ROLES)[number];

export const PERMISSIONS = [
  'organization.read',
  'organization.update',
  'organization.delete',
  'organization.manage_members',
  'organization.manage_roles',
  'project.read',
  'project.create',
  'project.update',
  'project.delete',
  'asset.read',
  'asset.create',
  'asset.update',
  'asset.delete',
  'asset.verify_ownership',
  'scope.read',
  'scope.update',
  'scan.read',
  'scan.create',
  'scan.cancel',
  'scan.create_aggressive',
  'finding.read',
  'finding.create',
  'finding.update',
  'finding.triage',
  'finding.accept_risk',
  'finding.delete',
  'evidence.read',
  'evidence.upload',
  'evidence.delete',
  'engagement.read',
  'engagement.create',
  'engagement.update',
  'engagement.delete',
  'report.read',
  'report.create',
  'report.download',
  'apikey.read',
  'apikey.create',
  'apikey.revoke',
  'webhook.read',
  'webhook.create',
  'webhook.update',
  'webhook.delete',
  'integration.read',
  'integration.manage',
  'notification.manage',
  'audit.read',
  'billing.read',
  'billing.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Permissions marked `P` in product/permissions.md: granted to GUEST only for
 * projects explicitly shared with them. The role grant is necessary but not
 * sufficient — the project grant is checked separately.
 */
export const PROJECT_SCOPED_PERMISSIONS = [
  'project.read',
  'asset.read',
  'scope.read',
  'scan.read',
  'finding.read',
  'evidence.read',
  'engagement.read',
  'report.read',
  'report.download',
] as const satisfies readonly Permission[];

/**
 * The canonical role -> permission mapping. product/permissions.md is the
 * human-readable rendering of this object, and permissions.spec.ts parses that
 * document and asserts the two agree cell by cell.
 */
export const ROLE_PERMISSIONS: Record<SystemRole, readonly Permission[]> = {
  OWNER: [...PERMISSIONS],

  ADMIN: [
    'organization.read', 'organization.update', 'organization.manage_members',
    'organization.manage_roles',
    'project.read', 'project.create', 'project.update', 'project.delete',
    'asset.read', 'asset.create', 'asset.update', 'asset.delete', 'asset.verify_ownership',
    'scope.read', 'scope.update',
    'scan.read', 'scan.create', 'scan.cancel', 'scan.create_aggressive',
    'finding.read', 'finding.create', 'finding.update', 'finding.triage',
    'finding.accept_risk', 'finding.delete',
    'evidence.read', 'evidence.upload', 'evidence.delete',
    'engagement.read', 'engagement.create', 'engagement.update', 'engagement.delete',
    'report.read', 'report.create', 'report.download',
    'apikey.read', 'apikey.create', 'apikey.revoke',
    'webhook.read', 'webhook.create', 'webhook.update', 'webhook.delete',
    'integration.read', 'integration.manage',
    'notification.manage',
    'audit.read',
    'billing.read',
  ],

  SECURITY_LEAD: [
    'organization.read',
    'project.read', 'project.create', 'project.update',
    'asset.read', 'asset.create', 'asset.update', 'asset.delete', 'asset.verify_ownership',
    'scope.read', 'scope.update',
    'scan.read', 'scan.create', 'scan.cancel', 'scan.create_aggressive',
    'finding.read', 'finding.create', 'finding.update', 'finding.triage', 'finding.accept_risk',
    'evidence.read', 'evidence.upload', 'evidence.delete',
    'engagement.read', 'engagement.create', 'engagement.update',
    'report.read', 'report.create', 'report.download',
    'apikey.read',
    'webhook.read',
    'integration.read',
    'notification.manage',
  ],

  MEMBER: [
    'organization.read',
    'project.read', 'project.create',
    'asset.read', 'asset.create', 'asset.update',
    'scope.read',
    'scan.read', 'scan.create', 'scan.cancel',
    'finding.read', 'finding.create', 'finding.update', 'finding.triage',
    'evidence.read', 'evidence.upload',
    'engagement.read', 'engagement.update',
    'report.read', 'report.create', 'report.download',
    'integration.read',
    'notification.manage',
  ],

  VIEWER: [
    'organization.read',
    'project.read',
    'asset.read',
    'scope.read',
    'scan.read',
    'finding.read',
    'evidence.read',
    'engagement.read',
    'report.read', 'report.download',
    'integration.read',
    'notification.manage',
  ],

  // An auditor proves that testing happened and that findings were remediated.
  // They deliberately lack evidence.read: evidence routinely contains customer
  // secrets and PII, and a compliance reviewer rarely needs the vulnerability
  // detail itself. See product/permissions.md, "deliberate oddities".
  AUDITOR: [
    'organization.read',
    'project.read',
    'asset.read',
    'scope.read',
    'scan.read',
    'finding.read',
    'engagement.read',
    'report.read', 'report.download',
    'apikey.read',
    'webhook.read',
    'integration.read',
    'notification.manage',
    'audit.read',
    'billing.read',
  ],

  // Every GUEST grant below is additionally gated on an explicit project grant.
  // A guest with no grants sees nothing.
  GUEST: [
    'organization.read',
    'project.read',
    'asset.read',
    'scope.read',
    'scan.read',
    'finding.read',
    'evidence.read',
    'engagement.read',
    'report.read', 'report.download',
    'notification.manage',
  ],
};
