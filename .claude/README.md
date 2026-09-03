# Internal engineering documentation

This tree is the authoritative internal knowledge base for **Sentinel**. The root
[`CLAUDE.md`](../CLAUDE.md) is deliberately short and points here.

## How to use this tree

| I need to... | Read |
|---|---|
| Understand the whole system | [`architecture/overview.md`](architecture/overview.md) |
| Set up locally | [`development/setup.md`](development/setup.md) |
| Know what Claude Code may do unattended | [`development/agent-permissions.md`](development/agent-permissions.md) |
| Change those permissions | [`development/agent-permissions-reference.md`](development/agent-permissions-reference.md) — the full catalogue to copy from |
| Add an API endpoint | [`api/conventions.md`](api/conventions.md), [`api/authorization.md`](api/authorization.md) |
| Change the schema | [`architecture/database.md`](architecture/database.md), [`development/migrations.md`](development/migrations.md) |
| Add a scan engine | [`scanners/adding-engines.md`](scanners/adding-engines.md), [`scanners/engine-contract.md`](scanners/engine-contract.md) |
| Understand a security control | [`security/overview.md`](security/overview.md) |
| Know why something is the way it is | [`decisions/`](decisions/) |
| Know what is actually built | [`product/roadmap.md`](product/roadmap.md) |
| Start, resume, or finish a phase | [`skills/`](skills/) — project skills: `sentinel-phase`, `sentinel-verify` |

## Map

```
architecture/   How the system is put together
security/       Threat model and every security control
product/        What we are building, for whom, and in what order
ui-ux/          Design system, page map, interaction rules
scanners/       Engine contract, execution, normalisation, evidence
api/            REST conventions the API must obey
development/    Setup, standards, testing, migrations
operations/     Environments, deploy, monitoring, backups, runbooks
decisions/      ADRs — the record of significant choices
skills/         Project skills: sentinel-phase, sentinel-verify
```

## Rules for this tree

1. **Documentation changes ship with the code change**, not after it. A PR that
   changes behaviour described here and does not update the description is incomplete.
2. **Describe what exists, and mark what does not.** Every document uses an explicit
   status marker where a section describes planned rather than built behaviour:

   > **Status: Not Implemented** — planned for Phase 6.

   Aspirational prose written in the present tense is the single most damaging thing
   that can be added to this tree, because it makes the system look finished when it
   is not.
3. **Decisions go in ADRs, not in prose.** If you find yourself explaining *why* at
   length in an architecture document, that is an ADR trying to escape.
4. **One concept, one home.** Link rather than restate; duplicated documentation
   drifts and then lies.

## Current status

See [`product/roadmap.md`](product/roadmap.md) for the authoritative phase status.
At the time of writing, **Phase 0 is complete and no application code exists.**
