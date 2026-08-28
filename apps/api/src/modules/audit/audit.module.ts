import { Module } from '@nestjs/common';
import { PlatformAuditService } from './platform-audit.service.js';

/**
 * The audit module, holding exactly one service so far.
 *
 * `architecture/backend.md` §1 already lists `audit/` among the modules; this
 * is the first thing to live in it. The tenant-facing audit query API of
 * `security/audit.md` §6 is Phase 3 and is not here.
 *
 * **It imports no `PrismaModule` and injects no `PRISMA`, deliberately.**
 * `PlatformAuditService.record` takes the caller's transaction handle, because
 * §2 requires the event and the change it describes to be one transaction. A
 * service holding its own client is a service that can write an event for a
 * change that then rolls back, which is the failure mode the rule exists to
 * prevent — so it cannot reach a client at all.
 */
@Module({
  providers: [PlatformAuditService],
  exports: [PlatformAuditService],
})
export class AuditModule {}
