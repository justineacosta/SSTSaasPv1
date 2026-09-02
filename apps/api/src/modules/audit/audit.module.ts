import { Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { PlatformAuditService } from './platform-audit.service.js';

/**
 * The audit module, holding the two writers ADR-0019's routing rule needs.
 *
 * `architecture/backend.md` §1 already lists `audit/` among the modules.
 * `PlatformAuditService` writes the events that have no organisation;
 * `AuditService`, added in Task 13, writes the ones that have one. The routing
 * rule is the presence of an organisation, and it is structural rather than
 * remembered: neither service can reach the other's table. The tenant-facing
 * audit query API of `security/audit.md` §6 is Phase 3 and is not here.
 *
 * **It imports no `PrismaModule` and injects no `PRISMA`, deliberately.**
 * `PlatformAuditService.record` takes the caller's transaction handle, because
 * §2 requires the event and the change it describes to be one transaction. A
 * service holding its own client is a service that can write an event for a
 * change that then rolls back, which is the failure mode the rule exists to
 * prevent — so it cannot reach a client at all.
 */
@Module({
  providers: [AuditService, PlatformAuditService],
  exports: [AuditService, PlatformAuditService],
})
export class AuditModule {}
