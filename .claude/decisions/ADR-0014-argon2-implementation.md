# ADR-0014 — Argon2id via `@node-rs/argon2`, with its parameters held in configuration

**Status:** Accepted · **Date:** 2026-08-25

## Context

[ADR-0005](ADR-0005-authentication-model.md) and
[`security/authentication.md`](../security/authentication.md) §2 both fix the algorithm:
**Argon2id**, "parameters tuned on production hardware to ~250ms (starting point: m=64MiB, t=3,
p=4), stored with the parameters so they can be raised later and rehashed transparently on next
successful login". Neither says which implementation, and the choice is not free.

Three constraints shape it.

**This is the repository's first native binary dependency.** Everything in the tree today is
JavaScript, TypeScript, or a dependency with no compiled artefact. A native module resolves a
different prebuilt binary per platform-and-libc triple, which means the dependency can install
cleanly on one machine and fail on another with no source change between them. Development happens
on Windows x64 under Node 26 (`v26.7.0 win32 x64`, measured 2026-08-25); CI runs `ubuntu-latest`;
Phase 11's production images are not written yet. **A resolution that works locally and fails on
the runner is the specific defect no local run can observe**, which is why the operator moved
Phase 2's first CI run forward from Checkpoint A to Task 2 — explicitly so that this task would
reach a Linux runner immediately rather than ten tasks later.

**The hash outlives the decision.** An Argon2id PHC string — `$argon2id$v=19$m=65536,t=3,p=4$...`
— is a portable, self-describing format. Every implementation below reads and writes it. So the
library is replaceable in code without touching a stored hash, *provided* the chosen one emits
standard PHC rather than a private encoding. That property is what makes this decision reversible
in code but not in the database, and that asymmetry is why it is an ADR rather than just a
dependency.

**[ADR-0013](ADR-0013-dependency-release-age-cooldown.md) applies.** A package published within
24 hours reds CI. `@node-rs/argon2@2.1.0` was published 2026-08-13 (`npm view @node-rs/argon2
time`, read 2026-08-25) — twelve days clear of the cooldown.

## Decision

**`@node-rs/argon2` is the Argon2id implementation.** It ships prebuilt napi-rs binaries per
platform: no `node-gyp` step, no Python, no MSVC toolchain on a Windows development machine, and
no build stage in a CI image.

**The parameters live in `packages/config`, not in a constant.** `m=64MiB, t=3, p=4` is the
starting point from `security/authentication.md` §2 and is explicitly only a starting point — that
document says the numbers get tuned on production hardware. Config-held parameters can be raised
in an environment without a code change, a build, or a deploy.

**`verify()` returns `{ valid, needsRehash }`.** `needsRehash` is true when the parameters embedded
in the stored PHC string are weaker than current configuration, and the caller rehashes
transparently on the next successful login. This is what makes raising the parameters a real
operation rather than an aspiration: without it, every hash in the database stays pinned to
whatever the parameters were on the day the account was created.

**The password ceiling of 256 characters stands on this decision.** Argon2id's cost is a function
of the configured memory and time parameters, not of input length, but the input is still hashed
and an unbounded one is a free amplification primitive. Carry-forward ruling 11 records that an
earlier justification attributed a "no maximum below 128" phrase to `security/authentication.md`
§2; **that document contains no such string** (`grep -rn "128" .claude/`). The ceiling's only
defence is the argument in this paragraph. Do not re-quote the phrase.

## Alternatives considered

**`argon2` (the `node-gyp` / `prebuild-install` package).** The most widely used option, and it
produces the same PHC strings, so this is a genuinely close call. Rejected on toolchain risk: when
no prebuilt artefact matches the platform, Node version, or libc, it falls back to compiling from
source through `node-gyp`, which requires Python and a C++ toolchain to be present. Node 26 is
recent enough that a missing prebuild is a live possibility rather than a theoretical one, and the
failure mode — a red install on a fresh clone or a new CI image, reporting a compiler error rather
than a dependency error — is expensive to diagnose and lands on whoever onboards next. Its own
prebuilt coverage is good; the objection is to the fallback existing at all.

**`hash-wasm` (pure WebAssembly).** The genuinely portable option: no native artefact, no
per-platform resolution, no libc question, and therefore none of the risk this ADR is mostly
about. Rejected because Argon2 is deliberately *memory-hard*, and memory-hard work is where a WASM
build gives up the most against a native one — the tuning target is a deliberate ~250ms, and a
slower primitive buys fewer rounds inside the same latency budget, which is a direct reduction in
the security the parameters exist to deliver. **This reasoning is not backed by a measurement taken
in this repository**, and it is recorded as reasoning, not as evidence. If the native route ever
becomes the more expensive one — an unsupported platform, a hostile base image — `hash-wasm` is
the fallback to reach for, and it reads the same PHC strings.

**Node's built-in `crypto.scrypt`.** Zero dependencies, which is genuinely attractive given
everything above. Rejected because it is not Argon2id. ADR-0005 and `security/authentication.md`
§2 both name Argon2id specifically, and scrypt lacks Argon2id's hybrid resistance to both
side-channel and GPU attack. Changing the algorithm is a different decision from choosing a
library; it would need its own ADR arguing the security case, not a convenience one.

**bcrypt.** Rejected. It silently truncates input at 72 bytes — which would make the 256-character
ceiling above a fiction — and it has no memory-hardness parameter at all, so it scales badly
against exactly the commodity GPU hardware Argon2id was designed to answer.

## Consequences

**Positive.** No compiler on any developer machine or CI image. The parameters are an operational
control rather than a code constant, and `needsRehash` makes raising them actually take effect on
existing accounts. The stored format is standard PHC, so a future ADR can swap the library without
a data migration.

**Negative — the real costs, stated plainly.**

- **The dependency tree now contains platform-specific binaries.** `pnpm install` resolves a
  different artefact on Windows, on `ubuntu-latest`, and in whatever Phase 11's production image
  turns out to be. Adding a platform to that matrix is now something that can fail on its own.
- **An Alpine/musl base image is a known trap for the Phase 11 Dockerfiles.** napi-rs publishes
  separate `*-linux-x64-musl` and `*-linux-x64-gnu` artefacts; choosing a musl base without
  confirming the artefact resolves produces a runtime failure at the first hash, not an install
  failure. **This is unverified today** — there is no production image yet — and it is recorded
  here so Phase 11 does not rediscover it the hard way.
- **The ~250ms target is untuned.** 64MiB / t=3 / p=4 is the document's starting point and nothing
  more; no production hardware exists to tune against. What these parameters cost on a developer
  laptop is not what they will cost on a production instance.
- **A native module is a larger supply-chain surface than a JavaScript one**, because a compromised
  release ships machine code rather than reviewable source. ADR-0013's 24-hour cooldown is the only
  control standing against that, and it is a weak one.

**Neutral.** Raising the parameters needs no migration — the config value changes and accounts
rehash as their owners next log in. Accounts that never log in keep their old hash indefinitely,
which is correct: a hash nobody authenticates against is not a live credential.
