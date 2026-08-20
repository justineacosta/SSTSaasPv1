export class MissingTenantContextError extends Error {
  constructor(model: string, operation: string) {
    super(
      `No organisation in context for ${model}.${operation}. ` +
        'Tenant-owned models must be queried through a tenant-scoped client.',
    );
    this.name = 'MissingTenantContextError';
  }
}
