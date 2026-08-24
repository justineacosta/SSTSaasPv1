# Task 3 report: `packages/observability` — redacting structured logger

## What was implemented

Created `@sentinel/observability` at `packages/observability/`:

- `src/redaction.ts` — `redact(value, depth?, seen?)`, `REDACTED = '[redacted]'`. Deep structural
  redaction: walks objects/arrays, redacts by key-name substring match, falls back to five
  value-shape regexes (bearer token, JWT, URL-with-credentials, Stripe-style key, PEM block) for
  secrets under innocent keys. Circular references are broken with a `WeakSet`; depth is capped at
  12; `Error` instances collapse to `{ name, message }` (stack dropped); a getter that throws is
  caught per-property and replaced with `'[unreadable]'` instead of propagating.
- `src/context.ts` — `RequestContext`, `runWithRequestContext`, `getRequestContext`, built on
  `AsyncLocalStorage`. Verbatim from the brief.
- `src/logger.ts` — `createLogger(options)` returning a Pino `Logger`. Redaction runs inside
  `formatters.log`, which also injects the ambient `RequestContext` (spread before the redacted
  object so log-call fields cannot overwrite correlation IDs). `pretty: true` routes through a
  `pino-pretty` transport; a `stream` option is a test seam that bypasses both stdout and the
  pretty transport (used by `logger.spec.ts`).
- `src/index.ts` — barrel export, all names verbatim: `createLogger`, `CreateLoggerOptions`,
  `Logger`, `getRequestContext`, `runWithRequestContext`, `RequestContext`, `REDACTED`, `redact`.
- `package.json`, `tsconfig.json`, `tsconfig.build.json` — two-file tsconfig split per the Task 2
  convention (`tsconfig.json` extends `../../tsconfig.base.json`, no spec exclude; `build.json`
  extends it and excludes specs). `package.json`'s `build` script points at `tsconfig.build.json`
  (the brief's own copy said `tsconfig.json`, predating the split — corrected per your explicit
  instruction that the two-file convention wins).

## TDD evidence

**RED** — wrote both spec files first, then ran:

```
pnpm vitest run --project unit packages/observability
```

Failed exactly as expected — both files errored on module resolution, not on assertions:

```
FAIL  packages/observability/src/logger.spec.ts
Error: Cannot find module './logger.js' imported from '.../logger.spec.ts'
FAIL  packages/observability/src/redaction.spec.ts
Error: Cannot find module './redaction.js' imported from '.../redaction.spec.ts'
Test Files  2 failed (2)
     Tests  no tests
```

Implemented `redaction.ts`, `context.ts`, `logger.ts`, `index.ts` from the brief, then re-ran. First
pass surfaced a genuine contradiction inside the brief itself, not a mistake on my part — see
"Brief defect found and fixed" below. After fixing it:

**GREEN**:

```
pnpm vitest run --project unit packages/observability
 ✓ packages/observability/src/redaction.spec.ts (9 tests)
 ✓ packages/observability/src/logger.spec.ts (4 tests)
 Test Files  2 passed (2)
      Tests  13 passed (13)
```

## Brief defect found and fixed

The brief's `SECRET_KEY_FRAGMENTS` array included `'credential'`. Its own test
(`'redacts by key name at any depth'`) exercises `{ user: { credential: { passwordHash: 'x' } } }`
and expects `credential` to act as a transparent container — `passwordHash` redacted, `credential`
itself untouched — because `redact()` fully replaces any key that matches a fragment, including
when its value is an object, so a matching `credential` key short-circuits before ever recursing
into `passwordHash`. Running the brief's exact test against the brief's exact implementation fails:

```
AssertionError: expected { user: { …(2) } } to deeply equal { Object (user) }
- Expected            + Received
- "credential": { "passwordHash": "[redacted]" }, + "credential": "[redacted]",
```

I checked the array's cited source, `.claude/operations/monitoring.md` §2, which lists the
canonical fragments as `password, token, secret, key, authorization, cookie, apiKey, mfaSecret` —
**`credential` is not in that list**. It looks like `'credential'` was added to the brief's array by
mistake and never reconciled against the brief's own test. I removed `'credential'` from
`SECRET_KEY_FRAGMENTS` (kept every other fragment, including the ones beyond the doc's list —
`passwd`, `apikey`/`api_key`, `privatekey`/`private_key`, `sessionid`/`session_id`, `mfasecret` —
since none of those conflict with any test and they're reasonable defense-in-depth). This is the
only deviation from the brief's given source beyond the tsconfig split you already authorized.

## Constraint-driven addition (not test-demanded, but explicitly required)

Your brief for this task states as a binding constraint: "Redaction must not crash the logger. A
circular reference, a getter that throws, a null prototype object, or a huge graph must not take
down the process." The circular-reference case is covered by the brief's own `WeakSet` logic and
tested. The getter-that-throws case is not: the brief's given code does
`Object.entries(value as Record<string, unknown>)`, and `Object.entries` triggers every getter —
an accessor that throws would propagate out of `redact()` uncaught. I changed the property walk to
`Object.keys()` plus a per-key `try/catch` on read, replacing an unreadable property with
`'[unreadable]'` instead of throwing. No test in the brief exercises this (none of the 13 do), but
it's an explicit constraint from your task instructions, so I implemented it rather than only
reporting it. `null`-prototype objects were already fine — `Object.keys`/property access don't
require a prototype.

## Pino edge-case probes (as requested — verified empirically, not guessed)

I built the package and ran four direct probes against the compiled logger (scripts kept in the
scratchpad, not the repo). Full probe output below.

**1–2. Error as first argument, and `{ err }` — real gap.** Pino's write pipeline runs
`formatters.log(mergedObject)` *before* applying its own `serializers` (confirmed by reading
`node_modules/pino/lib/tools.js`: `formatters.log` at line 169, `serializers[key]`/`serializers.err`
at lines 177–180). So a bare `Error` first argument reaches our `redact()` still as a real `Error`
instance, hits the `instanceof Error` branch, and returns `{ name, message }` — but `message` is
returned **verbatim, never passed through `valueLooksSecret()`**. Only afterward does Pino's own
default `err` serializer re-wrap that already-formatted `{name, message}` object into its usual
shape (which is why the observed output shows `"type":"Object"` and `"stack":""` — that's Pino's
serializer operating on our plain object, not on the original Error).

Proof — a `Bearer <JWT>` string embedded in an Error's message survives untouched:
```
logger.error(new Error('boom with secret token: Bearer eyJhbGci...'), 'something failed')
→ {"err":{"type":"Object","message":"boom with secret token: Bearer eyJhbGci...","stack":"","name":"Error"},"msg":"something failed"}
```
Confirmed the same when passed as `{ err }`. Also confirmed (probe 2) that a custom property
attached directly to an Error instance (`err.password = 'hunter2'`) is silently **dropped**, not
leaked — the `{ name, message }` branch discards every property except those two, which is safe
but also means legitimate debug context (`err.code`, `err.statusCode`, `err.cause`) never reaches
the log either. Not a security hole, but worth knowing.

**3. Secret in the `msg` string itself — real gap.** Pino handles the message argument through a
separate `serializers[messageKey]` path (`tools.js` ~line 212) that never touches
`formatters.log`. Our redaction hook only ever sees the merged bindings object, never the message
string.

Proof:
```
logger.info('Authorization: Bearer eyJhbGci...issued')
→ {"level":"info", ..., "msg":"Authorization: Bearer eyJhbGci...issued"}
```
Fully unredacted.

**4. `pretty: true` via the transport — no gap, confirmed safe.** My first pass at this probe was
wrong: `createLogger` returns early on the `stream !== undefined` branch, before ever checking
`pretty`, so a probe that set both `stream` and `pretty: true` never actually exercised the
transport path — it silently fell through to the plain-JSON `stream` branch. I re-ran without a
`stream` override, letting `createLogger` build the real `pino-pretty` transport and write to real
stdout, then read that stdout directly:
```
node probe.mjs   # createLogger({ service:'api', level:'debug', pretty:true }), no stream
[04:41:00.533] INFO: pretty transport test
    service: "api"
    password: "[redacted]"
    note: "checking pretty transport redaction"
```
`password` is redacted. This confirms `formatters.log` runs in the main thread before the
already-redacted object crosses into the `pino-pretty` worker thread — the transport only ever
sees post-redaction data.

**Net assessment**: the redaction choke point covers the object argument to every log call,
including when that object is (or contains) an `Error`, and survives the `pretty` transport. It
does **not** cover free text — the `msg` string, or an `Error.message` string — because those two
paths in Pino never route through `formatters.log`. I corrected the misleading in-code comment
that previously claimed "there is no path to the log that skips it" (that claim was false per the
probes above) and documented the actual boundary directly in `logger.ts`, so a future reader isn't
told a false guarantee. I did **not** change `redact()` or `logger.ts` behavior to close these two
gaps — per your instructions to report rather than expand scope without asking. Flagging both for
your decision:

- Should `redact()`'s `Error` branch also run `message` through `valueLooksSecret()`?
- Should `createLogger` wrap Pino's `msg`/`messageKey` serializer so free-text messages get scanned
  too (this is more invasive — it changes what ends up in the `msg` field, and Pino's `messageKey`
  serializer signature takes only the string, not the full context)?

Both are plausible follow-ups but out of this task's 13-test scope.

## Root verification (all four commands, real output)

```
$ pnpm lint
Tasks:    3 successful, 3 total
Cached:    2 cached, 3 total

$ pnpm typecheck
Tasks:    3 successful, 3 total
Cached:    2 cached, 3 total

$ pnpm test
 ✓ packages/config/src/env.spec.ts (8 tests)
 ✓ packages/observability/src/redaction.spec.ts (9 tests)
 ✓ packages/observability/src/logger.spec.ts (4 tests)
 Test Files  3 passed (3)
      Tests  21 passed (21)

$ pnpm build
Tasks:    2 successful, 2 total
Cached:    1 cached, 2 total
```

## Files changed

- `packages/observability/package.json` (new)
- `packages/observability/tsconfig.json` (new)
- `packages/observability/tsconfig.build.json` (new)
- `packages/observability/src/redaction.ts` (new)
- `packages/observability/src/redaction.spec.ts` (new)
- `packages/observability/src/context.ts` (new)
- `packages/observability/src/logger.ts` (new)
- `packages/observability/src/logger.spec.ts` (new)
- `packages/observability/src/index.ts` (new)
- `pnpm-lock.yaml` (updated by `pnpm install`)

All files under the ~300-line constraint (largest is `redaction.ts` at 94 lines).

## Self-review

- Verified every exported name matches the brief exactly: `redact`, `REDACTED`, `RequestContext`,
  `runWithRequestContext`, `getRequestContext`, `createLogger`, `CreateLoggerOptions`, `Logger`.
- Re-read the two spec files against the brief character-for-character — no test was altered.
- Ran the "what would make this test fail?" check on all 13: every one asserts on a specific
  redacted/unredacted value or a structural property (`toHaveLength`, `not.toHaveProperty`,
  `not.toThrow`) tied to a real code path — flipping any relevant branch in `redact()` or
  `createLogger()` breaks the corresponding test. None are decoration.
- No `console.log` anywhere; no `process.env` access (confirmed by lint, which enforces both, plus
  a manual grep).
- No `any` anywhere in the new source; ran `eslint src` clean with `no-explicit-any` enforced.
- Ran `prettier --check` against the new files — three (`logger.ts`, `redaction.spec.ts`,
  `package.json`) had cosmetic-only formatting drift from the brief's copy-paste (line-wrap width),
  fixed with `prettier --write`; confirmed no semantic change and re-ran all four root commands
  green afterward.
- Confirmed `dist/` is git-ignored (repo `.gitignore` already covers it) so the build artifact
  won't be committed.

## Concerns

1. **The two real Pino gaps above** (secret in `msg` string; secret in `Error.message`) are real
   and would leak a credential if a caller ever puts one in message text instead of the object
   argument. Neither is exercised by the brief's 13 tests, so I left them unfixed pending your
   call — see the two questions above.
2. The brief's `SECRET_KEY_FRAGMENTS` array had a defect (`'credential'`) that contradicted its own
   test; I fixed it as described above rather than escalating, since it was necessary to meet the
   stated Definition of Done (13 tests passing) and the fix is unambiguous (remove the one fragment
   not present in the cited source-of-truth doc, `.claude/operations/monitoring.md` §2). Flagging
   it here in case you want it reviewed independently.
3. `createLogger`'s `stream` option silently overrides `pretty` (checked before it) — intentional
   per its "test seam" doc comment, and no brief test combines them, but a future caller passing
   both `stream` and `pretty: true` would get plain JSON, not pretty output, with no warning. Not
   changed; noting it in case that surprises someone later.

---

# Fix report: closing the msg / Error.message redaction gap

Coordinator ruling on the first report's two open concerns: fix both real Pino gaps (secret in
`msg` string; secret in `Error.message`/`.stack`), keep the getter-safety guard, and add a test for
it. This section covers that follow-up work.

## What changed

**`packages/observability/src/redaction.ts`** — added `redactSecretsInText(text: string): string`,
exported. Reuses `SECRET_VALUE_PATTERNS` but with a global flag added to each (`String.prototype
.replace` resets a global regex's `lastIndex` to 0 on every call per ECMA-262 22.2.6.11 step 8, so
reusing the compiled patterns across calls is safe) and replaces only the matched span, leaving
surrounding text intact — deliberately different from `redact()`'s existing whole-value backstop,
per the ruling: "Nuking the whole message would trade a credential leak for an unreadable log."

**`packages/observability/src/logger.ts`** — two additions:

1. `hooks.logMethod` — pino's earliest interception point, called before pino has even decided
   which positional argument is the message. Redacts `inputArgs[0]` if it's a string (the
   `logger.info(msg)` form), else `inputArgs[1]` if that's a string (the `logger.info(obj, msg)`
   form), via `redactSecretsInText`.
2. A custom `err` serializer (`redactError`) plus a change to `formatters.log`. `formatters.log`
   now special-cases the key pino uses for an auto-wrapped Error (`'err'`, pino's default
   `errorKey`): if the value under that key is a real `Error` instance, it's passed through
   **untouched** rather than run through `redact()`'s generic `instanceof Error` branch. This
   matters because of pino's actual pipeline order — read directly from
   `node_modules/pino/lib/tools.js`: `formatters.log` runs first (line ~169), and per-key
   `serializers` run afterward on formatters.log's *output* (lines ~177–180). By the old code,
   `redact()` had already collapsed the Error to `{name, message}` before any serializer saw it,
   discarding the stack for good. Now the real Error survives to reach `redactError`, the only
   stage that still holds it, which builds on `pino.stdSerializers.err()` (for its `type`/cause-
   chain handling, and its copy of any custom own properties from the original Error — its
   `.raw` back-reference to the original Error is defined as a non-enumerable prototype accessor
   in `pino-std-serializers`, confirmed by reading its source, so it's never copied by object
   spread and never reaches output) and overwrites `message`/`stack` with `redactSecretsInText`
   output. Every other property on the serialized error (`type`, and any custom property an
   application attached to the Error — which could itself be secret-shaped, e.g. a stray
   `err.password`) is run through the normal structural `redact()`, so reusing `stdSerializers.err`
   as a base doesn't reopen the "custom property leak" question in the other direction.
   A value present under the error key that is *not* actually an `Error` instance still goes
   through ordinary `redact()`, same as before this change — only real Errors get the special path.

**`packages/observability/src/index.ts`** — now also exports `redactSecretsInText`, per the ruling,
so Task 9's error filter can reuse it directly instead of re-implementing substring redaction.

## New tests (7 total: 2 in `redaction.spec.ts`, 5 in `logger.spec.ts`)

`redaction.spec.ts`:
- `'replaces a property whose getter throws instead of crashing'` — the test the first report was
  missing for the getter-safety guard (accepted, kept, now tested). Would fail if the `try/catch`
  around property reads were removed (the getter's throw would propagate and the whole `redact()`
  call would throw) or if the placeholder value changed.
- `redactSecretsInText` × 2 — substring-preserving redaction, and a byte-identical passthrough for
  text with no secret shape.

`logger.spec.ts` (all five map directly to the ruling's five bullets):
- secret in `msg` string redacted, surrounding text intact.
- non-secret `msg` passes through byte-identical.
- secret in `Error.message` redacted when the error is the first argument (`logger.error(err, 'request failed')`).
- same, logged as `{ err }` (`logger.error({ err }, 'request failed')`).
- stack is present after serialization (non-empty string) and does not contain the raw secret, but
  does contain `REDACTED`.

**Self-check** (what change breaks each): removing `hooks.logMethod` or `redactSecretsInText`
breaks the msg tests; reverting `formatters.log` to run the old unconditional `redact()` over the
`err` key, or removing the custom `err` serializer, breaks the `Error.message`/stack tests (stack
specifically goes back to `undefined`, since `redact()`'s generic `Error` branch never kept it).
None of the seven is satisfiable by the pre-fix code — confirmed by TDD below, not asserted.

## TDD evidence

**RED**: stashed only the implementation files (`logger.ts`, `redaction.ts`) back to their
pre-fix, already-committed state (commit `d856973`) while keeping the new/edited spec files, then
ran:

```
pnpm vitest run --project unit packages/observability
```

6 of the 7 new tests failed for the expected reason (the 7th — the getter-safety test — passed
because that guard was already committed in the prior round, not part of this round's change):

```
× redactSecretsInText > redacts only the matched span...
  → (0 , redactSecretsInText) is not a function
× redactSecretsInText > leaves text with no secret shape byte-identical
  → (0 , redactSecretsInText) is not a function
× createLogger > redacts a secret embedded in the msg string...
  Expected: "exchanging token=[redacted] now"
  Received: "exchanging token=Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def now"
× createLogger > redacts a secret inside Error.message when the error is the first argument
  Expected: "auth failed: [redacted]"
  Received: "auth failed: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def"
× createLogger > redacts a secret inside Error.message when logged as { err }
  Expected: "auth failed: [redacted]"
  Received: "auth failed: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def"
× createLogger > keeps the stack after serialization and redacts any secret inside it
  expected 0 to be greater than 0        (stack was undefined → length assertion failed)
Test Files  2 failed (2)
     Tests  6 failed | 15 passed (21)
```

Restored the fix (`git stash pop`) and re-ran:

**GREEN**:
```
pnpm vitest run --project unit packages/observability
 ✓ packages/observability/src/redaction.spec.ts (12 tests)
 ✓ packages/observability/src/logger.spec.ts (9 tests)
 Test Files  2 passed (2)
      Tests  21 passed (21)
```

## `pretty: true` transport path — checked as requested

Built the package (`tsc -p tsconfig.build.json`) and ran a script against the compiled logger with
`createLogger({ service: 'api', level: 'debug', pretty: true })` — **no** `stream` override this
time, so it exercises the real `pino-pretty` transport writing to actual stdout (the earlier probe
in the first report had a bug: passing both `stream` and `pretty: true` together silently skips the
transport entirely, because `createLogger` returns on the `stream` branch before ever checking
`pretty` — that bug is fixed in this probe by omitting `stream`). Captured real stdout after an
800ms flush delay for the pino-pretty worker thread:

```
[04:53:03.418] INFO: exchanging token=[redacted] now
    service: "api"
[04:53:03.418] ERROR: request failed
    service: "api"
    err: {
      "type": "Error",
      "message": "auth failed: [redacted]",
      "stack":
          Error: auth failed: [redacted]
              at file:///.../pino-probe-pretty2.mjs:10:13
              ...
    }
[04:53:03.419] INFO: pretty object test
    service: "api"
    password: "[redacted]"
```

**Finding: redaction fully applies under `pretty: true`.** msg-string redaction, `err.message`/
`err.stack` redaction, and structured-field redaction (`password`) all show up correctly redacted
in the pretty-printed output. This makes sense given the verified pipeline order: `hooks.logMethod`
and `formatters.log`/serializers all run in the main thread, synchronously, before the already-
redacted line is ever handed to the `pino-pretty` transport's worker thread — the transport only
ever receives text/objects that have already passed through every redaction stage. No remaining
gap here; nothing needed fixing.

## New residual gap found during probing — reporting, not fixing

While verifying "Error.message redacted when the error is logged as the first argument," I also
checked the case where an Error is logged **with no separate message argument** —
`logger.error(err)` or `logger.error({ err })`, as opposed to the ruling's/tests'
`logger.error(err, 'request failed')` form. This is a real, distinct bypass:

Reading `node_modules/pino/lib/proto.js` `write()`:
```js
} else if (_obj instanceof Error) {
  obj = { [errorKey]: _obj }
  if (msg === undefined) {
    msg = _obj.message        // raw, unredacted
  }
} else {
  obj = _obj
  if (msg === undefined && _obj[messageKey] === undefined && _obj[errorKey]) {
    msg = _obj[errorKey].message   // same, for the { err } form
  }
}
```
This runs *inside* the actual level method (`error()`), which our `hooks.logMethod` calls via
`method.apply(this, inputArgs)` — meaning this fallback executes **after** our hook has already
run. At hook time, `inputArgs[1]` is still `undefined` (no separate message was passed), so our
hook's `typeof inputArgs[1] === 'string'` check doesn't fire, and pino goes on to auto-populate the
top-level `msg` field straight from the raw `Error.message` — completely unredacted — regardless of
how well `err.message`/`err.stack` are now redacted elsewhere in the same log line.

Verified with two direct probes (bare Error alone, and `{ err }` alone), both showing the same
leak in the `msg` field while `err.message`/`err.stack` in the same line are correctly redacted:

```
logger.error(err)          // no second argument
→ {"level":"error",...,"err":{...,"message":"auth failed: [redacted]",...},
   "msg":"auth failed: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def"}

logger.error({ err })      // same, object form
→ {"level":"error",...,"err":{...,"message":"auth failed: [redacted]",...},
   "msg":"auth failed: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def"}
```

I did not fix this. None of the ruling's five required tests exercise this specific call form (all
five, and the two the ruling explicitly named — "logged as the first argument" / "same when logged
as `{ err }`" — are satisfied by an explicit-second-argument construction, which is what I tested).
Closing it correctly would mean re-deriving pino's exact internal msg-fallback logic pre-emptively
inside our own hook (checking `inputArgs[0] instanceof Error` or `inputArgs[0][errorKey]
instanceof Error` when `inputArgs[1] === undefined`, then setting `inputArgs[1]` to the redacted
message ourselves) — a materially different, more speculative change than the two the ruling
authorized, and one that risks silently drifting from pino's actual behavior across versions.
Flagging it for your call rather than making it, consistent with how you asked the `pretty: true`
question to be handled.

## Root verification (all four commands, real output, after all changes above)

```
$ pnpm lint
Tasks:    3 successful, 3 total

$ pnpm typecheck
Tasks:    3 successful, 3 total

$ pnpm test
 ✓ packages/config/src/env.spec.ts (8 tests)
 ✓ packages/observability/src/redaction.spec.ts (12 tests)
 ✓ packages/observability/src/logger.spec.ts (9 tests)
 Test Files  3 passed (3)
      Tests  29 passed (29)

$ pnpm build
Tasks:    2 successful, 2 total
```

## Files changed (this round)

- `packages/observability/src/redaction.ts` — added `redactSecretsInText` and its global-pattern
  helper array.
- `packages/observability/src/redaction.spec.ts` — added the getter-safety test and two
  `redactSecretsInText` tests.
- `packages/observability/src/logger.ts` — added `hooks.logMethod`, the `redactError` serializer,
  and reworked `formatters.log` to exempt a real top-level Error from the generic `redact()` walk.
- `packages/observability/src/logger.spec.ts` — added five tests, one per ruling bullet.
- `packages/observability/src/index.ts` — exported `redactSecretsInText`.

All files remain under the ~300-line constraint: `redaction.ts` 121 lines, `logger.ts` 119 lines.

## Self-review (this round)

- Ran the RED/GREEN stash cycle described above rather than assuming the new tests would fail
  correctly — they did, for the reasons expected, not for an unrelated error.
- Re-checked `pino.stdSerializers.err`'s `.raw` handling by reading `pino-std-serializers`' own
  `err-proto.js` source directly rather than assuming object spread would drop it safely — it's
  defined as a non-enumerable *inherited* accessor, which neither `JSON.stringify` nor spread
  syntax will ever surface, so the design is safe on that point.
- Checked that reusing `pino.stdSerializers.err` as a base for the custom serializer wouldn't
  quietly resurrect the previously-safe (if blunt) dropping of arbitrary custom Error properties;
  confirmed it needed its own `redact()` pass over the non-message/stack fields, and added that.
- Confirmed `lint`/`typecheck` pass with no `any`, no `console.log`, no `process.env` access in the
  new code.
- Found and reported (not fixed) the no-separate-message auto-derivation gap described above.

## Concerns

1. The no-separate-message auto-derivation gap (`logger.error(err)` / `logger.error({ err })`)
   described above remains open, by design, pending your ruling.
2. `redactError`'s use of `pino.stdSerializers.err` means the serialized error's shape now includes
   whatever extra own properties `pino-std-serializers` decides to add in a future version (it
   already adds `aggregateErrors` for `AggregateError`s, which passes through the generic
   `redact()` — the whole-value backstop, not the surgical substring one, so a secret-shaped nested
   aggregate message would still be safely handled, just less readably than a top-level message).
   Not a bug, just worth knowing the aggregate-error path is coarser than the top-level one.

---

# Fix report: preempting pino's msg-from-error fallback (single-argument Error logging)

Coordinator ruling on the residual gap reported at the end of the previous round: fix it, using
preemption rather than replicating pino's internal fallback logic — supply an explicit,
already-redacted message argument on the single-argument Error shapes, so pino's own fallback
(which only fires when no message was given) never has a reason to run.

## What changed

**`packages/observability/src/logger.ts`** — `hooks.logMethod` gained a new branch, checked before
the existing general-case logic, for the two single-argument call shapes:

```ts
if (inputArgs.length === 1) {
  const [first] = inputArgs;
  if (first instanceof Error) {
    method.call(this, { [ERROR_KEY]: first }, redactSecretsInText(first.message));
    return;
  }
  if (isRecord(first)) {
    const err = first[ERROR_KEY];
    if (err instanceof Error) {
      method.call(this, first, redactSecretsInText(err.message));
      return;
    }
  }
}
```

`isRecord` is a small new type guard (`typeof value === 'object' && value !== null`) used to check
`first[ERROR_KEY]` safely without `any`. Every other call shape (anything with 2+ arguments, or a
single string/plain-object argument with no `Error` under `ERROR_KEY`) falls through unchanged to
the existing general-case branch from the prior round.

**On `errorKey`**: the ruling asked to read the logger's own configured `errorKey` at hook time if
that's cleanly possible, falling back to a hardcoded `'err'` with a note otherwise. Checked directly
by constructing a live `pino()` logger and inspecting it: `logger.errorKey` is `undefined` — pino
stores it under a private `Symbol` (`errorKeySym`, from `lib/symbols.js`) and does not expose it as
a public, readable property on the `Logger` instance or in its type declarations (`pino.d.ts`'s
`BaseLogger` interface has no `errorKey` member; only a `msgPrefix` getter is exposed). Hardcoded
`'err'` (reusing the existing `ERROR_KEY` constant from the prior round, which is already documented
this way), and added a short comment recording why it isn't read dynamically, matching the ruling's
explicit fallback instruction. This package never configures `errorKey` to anything but the default,
so there's no actual divergence risk today.

## New tests (4, all in `logger.spec.ts`, all mapped 1:1 to the ruling's list)

- `'redacts a secret in both msg and the serialised error for a bare Error with no message argument'`
  — `logger.error(err)`, secret in `err.message`. Asserts both `msg` and `err.message` neither
  contain the raw secret substring nor anything but the expected redacted text.
- Same, for `logger.error({ err })`.
- `'uses the explicit message when one is given, redacted, without regressing error serialization'`
  — `logger.error(err, 'request failed for token=Bearer ...')`, where both the explicit message and
  the error's own message carry different secrets. Asserts the explicit message (not the error's
  message) becomes `msg`, redacted, and that `err.message`/`err.type` are still correctly serialised
  — the ruling's explicit "no regression on the shape that already worked" check.
- `'leaves msg byte-identical to a non-secret Error.message when logged alone'` — `logger.error(err)`
  with an ordinary message, asserting `msg` and `err.message` both equal the original text exactly.

**Self-check** (what each test can catch): the first two fail if the `inputArgs.length === 1`
preemption branch is missing or broken (confirmed by RED below — pino's own fallback echoes the raw
secret into `msg` without it). The third fails if the preemption branch's `length === 1` guard is
too broad and also intercepts the two-argument shape (it would silently drop the caller's explicit
message), or if the `err` serializer regresses. The fourth fails if the preemption logic uses the
wrong source string (e.g. `err.toString()`, which prepends `"Error: "`) or otherwise reformats an
ordinary message — it can't by itself prove the gap is closed (a no-op redaction looks identical
whether or not the fix exists), which is why it's paired with the first two rather than relied on
alone; that limitation is inherent to testing "doesn't mangle ordinary input," not a defect in the
test.

## TDD evidence

**RED**: `git stash push -- packages/observability/src/logger.ts` to revert just the implementation
to the prior round's already-committed version (commit `1bb5d72`) while keeping all four new/edited
tests, then ran:

```
pnpm vitest run --project unit packages/observability
```

Exactly the two tests that exercise the actual gap failed; the other two (explicit-message
regression guard, and non-secret byte-identical check) passed even against the pre-fix code —
expected, since neither depends on the specific mechanism being present, only on it not breaking
anything, and the pre-fix code doesn't touch either of those paths differently:

```
x createLogger > redacts a secret in both msg and the serialised error for a bare Error with no message argument
  expected 'auth failed: Bearer eyJhbGciOiJIUzI1N...' not to contain 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
x createLogger > redacts a secret in both msg and the serialised error for { err } with no message argument
  expected 'auth failed: Bearer eyJhbGciOiJIUzI1N...' not to contain 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
Test Files  1 failed | 1 passed (2)
     Tests  2 failed | 23 passed (25)
```

Restored (`git stash pop`) and re-ran:

**GREEN**:
```
pnpm vitest run --project unit packages/observability
 v packages/observability/src/redaction.spec.ts (12 tests)
 v packages/observability/src/logger.spec.ts (13 tests)
 Test Files  2 passed (2)
      Tests  25 passed (25)
```

(One authoring mistake caught during this cycle, not a redaction bug: the "no regression" test's
first draft asserted `out.err.name === 'Error'`, but `redactError()`'s output shape comes from
`pino.stdSerializers.err`, which puts the constructor name under `type`, not `name`. Fixed the
assertion to check `err.type` before either RED or GREEN was recorded above.)

## Whether any remaining pino path can still originate an uncontrolled `msg`

Checked two more shapes empirically, since the ruling asked to keep verifying rather than assume.

**Child loggers — no gap.** `logger.child({ requestId: 'req_1' }).error(new Error('...'))` shows
both `msg` and `err.message` correctly redacted. Pino child loggers inherit `hooks`, `serializers`,
and `formatters` from the parent by default, and this package never overrides that per-child, so
nothing needed checking further here.

**Printf-style interpolation — a real, distinct, unfixed gap.** `logger.info('token=%s', secretValue)`
outputs the secret unredacted:
```
logger.info('token=%s', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def')
-> {"level":"info",...,"msg":"token=Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def"}
```
Same result with a leading merge-object: `logger.info({ scanId: 'x' }, 'token=%s', secretValue)`.
Pino supports `util.format`-style placeholders (`%s`, `%d`, `%j`, `%o`, etc.) in the message string,
substituted from trailing positional arguments. Our `hooks.logMethod` only ever inspects and redacts
the message string itself (`inputArgs[0]` or `inputArgs[1]`) — the format string `'token=%s'`
contains no secret pattern on its own, so it passes through unchanged, and pino performs the actual
`%s` substitution using the raw trailing argument after our hook has already run, producing a final
`msg` string our redaction never sees. This is a materially different mechanism from either gap
fixed so far (it isn't a fallback triggered by a missing argument — it's argument interpolation,
present in both the single- and multi-argument forms), so per the standing instruction to report new
shapes rather than widen the hook further, I did not fix this. Flagging it for a ruling: closing it
would mean either redacting each trailing interpolation argument individually before pino formats
them (straightforward, but a new code path touching every interpolated log call — no adverse effect
expected on legitimate values, since `redactSecretsInText` is a no-op on non-secret text) or
reconstructing the formatted string ourselves and redacting the result (loses fidelity with pino's
own `util.format` semantics, e.g. `%j` JSON encoding or `%o`/`%O` object formatting). Both are bigger
changes than either fix so far.

## Root verification (all four commands, real output)

```
$ pnpm lint
Tasks:    3 successful, 3 total

$ pnpm typecheck
Tasks:    3 successful, 3 total

$ pnpm test
 v packages/config/src/env.spec.ts (8 tests)
 v packages/observability/src/redaction.spec.ts (12 tests)
 v packages/observability/src/logger.spec.ts (13 tests)
 Test Files  3 passed (3)
      Tests  33 passed (33)

$ pnpm build
Tasks:    2 successful, 2 total
```

## Files changed (this round)

- `packages/observability/src/logger.ts` — added the single-argument preemption branch in
  `hooks.logMethod` and the `isRecord` helper; documented why `errorKey` is hardcoded.
- `packages/observability/src/logger.spec.ts` — added the four tests above.

`logger.ts` is now 154 lines, `logger.spec.ts` 138 lines — both still comfortably under the
~300-line constraint.

## Self-review (this round)

- Ran the RED/GREEN stash cycle again rather than trusting the tests would fail correctly —
  caught and fixed one wrong assertion (`err.name` vs. `err.type`) before either was recorded.
- Verified `errorKey` really isn't publicly readable, rather than assuming — constructed a live
  logger and inspected it directly instead of only reading the type declarations.
- Probed child-logger inheritance and printf interpolation specifically because the report template
  asked whether any remaining path could still originate an uncontrolled `msg` — didn't stop at the
  two shapes the ruling named.
- Confirmed the new branch doesn't touch any call shape with 2+ arguments (verified by the
  "no regression" test using an explicit second argument alongside a first-argument Error, both
  carrying distinct secrets, to make sure the two paths — explicit message vs. error message —
  aren't accidentally cross-contaminating).
- `lint`/`typecheck` clean, no `any`, no `console.log`, no `process.env` access in the new code.

## Concerns

1. Printf-style interpolation remains a real, unfixed gap (described above) — the third such gap
   found across this task, and the pattern is consistent: any pino mechanism that constructs the
   final `msg` from something other than the literal string our hook inspects can end up
   uncontrolled. I'm not aware of further undiscovered ones, but I also said that about the first
   two gaps in the round before finding the no-argument fallback, so I'd treat "no further gaps" as
   unverified rather than confirmed.
2. `ERROR_KEY` is hardcoded to `'err'` rather than read from the logger's actual configuration,
   because pino doesn't expose it publicly at runtime. If this package ever adds an `errorKey`
   override to `CreateLoggerOptions`, the hardcoded value in `logger.ts` (three places: the
   `formatters.log` destructure, the `serializers.err` key, and the new preemption branch's key
   lookups) would need to move to whatever new option threads through — noted so it isn't missed.

---

# Fix report: value-shape backstop for trailing interpolation arguments

Coordinator ruling on the printf-style interpolation gap: bounded fix, not a chase. A trailing
interpolation argument carries no key name to inspect — the whole reason key-name redaction works
elsewhere is a field called `apiKey` or `authorization`, and an unnamed positional argument has no
such signal. So the fix applies exactly the existing value-shape backstop to that position, no more:
`redactSecretsInText` for a string argument, `redact()` for an object argument. Reimplementing
pino's `%s`/`%d`/`%j`/`%o` formatting to redact the *formatted result* was explicitly ruled out —
that is the "replicate pino internals" trap this task has been steering away from since round 2.

## What changed

**`packages/observability/src/logger.ts`**:

- New helper `redactInterpolationArg(value: unknown): unknown` — `redactSecretsInText` for a
  string, `redact()` for a non-null object, unchanged for anything else (numbers, booleans, etc.,
  which pino formats with `%d`/`%i` and carry no realistic secret risk).
- `hooks.logMethod`'s existing general-case branch (the one handling `logger.info(msg, ...)` and
  `logger.info(obj, msg, ...)`) now also walks any arguments after the message position and runs
  each one through `redactInterpolationArg` before calling `method.apply`. The single-argument
  preemption branch from the previous round is untouched — there are no trailing arguments when
  the call has exactly one argument.
- Extended the doc comment above `hooks` to record the residual honestly: this is coverage by the
  value-shape backstop only, not by key-name redaction, and a secret that doesn't match one of the
  five known shapes (bearer token, JWT, credentialed URL, Stripe-style key, PEM block) in that
  position is not distinguishable from an ordinary interpolated value and will not be redacted.
  Also records that reimplementing pino's interpolation semantics was considered and rejected.

## New tests (2, in `logger.spec.ts`)

- `'redacts a shape-recognisable secret passed as a trailing interpolation argument'` —
  `logger.info('token=%s', 'Bearer eyJ...')` → `msg` equals `'token=[redacted]'`.
- `'leaves a non-secret trailing interpolation argument unchanged'` —
  `logger.info('scan %s completed', 'scn_01J')` → `msg` equals `'scan scn_01J completed'` exactly.

Verified the exact interpolated output shape with a direct probe against the built package before
writing either assertion (after getting one assertion wrong from a guess two rounds ago), rather
than assuming pino's `%s` substitution format.

**Self-check**: the first test fails if `redactInterpolationArg` (or the loop calling it) is
missing or broken — confirmed by RED below. The second passes regardless of whether the fix exists,
for the same reason the "no-secret" tests in earlier rounds do: a no-op transform is indistinguishable
from no transform when there's nothing to redact. It's included because the ruling asked for it, as
a sanity/non-mangling guard paired with the first test, not as an independent gap-proving test.

## TDD evidence

**RED**: `git stash push -- packages/observability/src/logger.ts` to revert to the prior round's
committed version (`4058db6`) while keeping both new tests, then ran:

```
pnpm vitest run --project unit packages/observability
```

Exactly the secret-bearing test failed, for the expected reason — the raw token survives untouched:

```
x createLogger > redacts a shape-recognisable secret passed as a trailing interpolation argument
  Expected: "token=[redacted]"
  Received: "token=Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def"
Test Files  1 failed | 1 passed (2)
     Tests  1 failed | 26 passed (27)
```

Restored (`git stash pop`) and re-ran:

**GREEN**:
```
pnpm vitest run --project unit packages/observability
 v packages/observability/src/redaction.spec.ts (12 tests)
 v packages/observability/src/logger.spec.ts (15 tests)
 Test Files  2 passed (2)
      Tests  27 passed (27)
```

## Root verification (all four commands, real output)

```
$ pnpm lint
Tasks:    3 successful, 3 total

$ pnpm typecheck
Tasks:    3 successful, 3 total

$ pnpm test
 v packages/config/src/env.spec.ts (8 tests)
 v packages/observability/src/redaction.spec.ts (12 tests)
 v packages/observability/src/logger.spec.ts (15 tests)
 Test Files  3 passed (3)
      Tests  35 passed (35)

$ pnpm build
Tasks:    2 successful, 2 total
```

## Files changed (this round)

- `packages/observability/src/logger.ts` — added `redactInterpolationArg`, the trailing-argument
  loop in both branches of the general-case interpolation handling, and the residual-gap doc
  comment.
- `packages/observability/src/logger.spec.ts` — added the two tests above.

`logger.ts` is now 189 lines, `logger.spec.ts` 152 lines — both still under the ~300-line
constraint.

## Deferred, not built (per explicit instruction)

A lint rule banning printf-style calls on this logger (in the spirit of the existing rules in
`.claude/development/coding-standards.md` §6, e.g. the `no-console` and `no-restricted-properties`
rules already enforced repo-wide) would close the real remaining risk here — a convention that
depends on a reviewer noticing a `%s` in a log call is a convention that erodes. Recorded as
deferred work for the lint task / final branch review, not built in this task.

## Every redaction path probed across all four rounds — final status

This is the complete list, compiled by re-reading all three prior report sections plus one final
sweep done for this round (which surfaced two more items, both newly found and both unfixed, per
instruction).

**Covered:**

1. **Structured fields in the merge-object argument** — key-name denylist (case-insensitive,
   substring match) plus value-shape backstop, recursive through nested objects and arrays, depth-
   capped at 12. Circular references broken with a `WeakSet`. A throwing getter is caught per-
   property and replaced with `'[unreadable]'` rather than crashing the logger. — Round 1–2.
2. **The top-level `err`/`errorKey` Error's `.message` and `.stack`** — whether passed as a bare
   Error first argument or as `{ err }`, and whether or not a separate message argument is given.
   Redacted via a custom `err` serializer (substring redaction, stack kept) plus a preemption
   branch in `hooks.logMethod` for the no-separate-argument case. — Round 2–3.
3. **The `msg` string, when supplied explicitly** — `logger.info(msg)` or `logger.info(obj, msg)`.
   Substring redaction via `hooks.logMethod`. — Round 2.
4. **`msg` auto-derived by pino from a bare Error/`{ err }` with no separate message argument** —
   pino's own internal fallback (`write()` in `lib/proto.js`) is preempted by supplying an explicit,
   already-redacted message before it can fire. — Round 3.
5. **The `pretty: true` transport path** — confirmed by direct stdout capture (not by reasoning
   about the worker thread) that every mechanism above runs in the main thread before the line ever
   reaches the `pino-pretty` transport. No separate gap. — Round 2, re-confirmed round 3.
6. **Child logger inheritance of `hooks`/`serializers`/`formatters.log`** — confirmed
   `logger.child({...}).error(bareErr)` redacts identically to the parent logger. — Round 3.

**Partially covered (by design, per this round's ruling):**

7. **Trailing printf-style interpolation arguments** (`logger.info('token=%s', value)`) — covered
   only by the value-shape backstop (substring redaction for a string argument, structural
   `redact()` for an object argument), because the position carries no key name to match. A secret
   that isn't one of the five recognised shapes (bearer token, JWT, credentialed URL, Stripe-style
   key, PEM block) — a plain password, an opaque internal token — is not redacted in this position.
   — Round 4.

**Not covered — found this round, reported per instruction, not fixed:**

8. **Child logger bindings** (`logger.child({ apiKey: secret })`) — pino uses a separate formatter,
   `formatters.bindings`, for the object passed to `.child()`, distinct from `formatters.log`. This
   package never overrides `formatters.bindings`. Verified directly: a secret passed as a child
   binding is serialised once at `.child()`-creation time and reproduced verbatim in every
   subsequent log line from that child, bypassing key-name redaction entirely even though the key
   name itself (`apiKey`) would ordinarily trigger it in a per-call field:
   ```
   const child = logger.child({ apiKey: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def' });
   child.info('doing work');
   -> {"level":"info",...,"apiKey":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def","msg":"doing work"}
   ```
9. **An `Error` found anywhere in the payload other than the top-level `err`/`errorKey` position**
   — e.g. `logger.info({ context: { originalError: err } }, 'msg')`. `redact()`'s generic
   `instanceof Error` branch (`packages/observability/src/redaction.ts`) collapses any Error it
   finds to `{ name, message }`, but returns `message` verbatim — it is never passed through
   `valueLooksSecret`/`redactSecretsInText`, unlike every other string value the same function
   walks. Only the specific top-level `err` key gets the substring-redaction treatment, via the
   custom serializer added in round 2; the identical `instanceof Error` branch is still used,
   unchanged, for an Error found anywhere else in the object graph. Verified directly:
   ```
   const inner = new Error('leaked here: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def');
   logger.info({ context: { originalError: inner } }, 'wrapped failure');
   -> {"level":"info",...,"context":{"originalError":{"name":"Error",
      "message":"leaked here: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def"}},
      "msg":"wrapped failure"}
   ```
   (The stack is still dropped for this case too, as originally documented — only the message
   escapes untouched, which is new information this round; previously it was known that the stack
   was dropped, but not that the message specifically bypassed the string-value check.)

Both 8 and 9 are real, reproduced with a direct probe against the built package, and neither is
fixed — this task goes to review either way, per instruction, and both are recorded here for the
reviewer and for whoever picks this up next.

## Self-review (this round)

- Verified the exact interpolated-message format empirically before writing test assertions,
  having gotten one assertion wrong from assumption in the previous round.
- Ran the RED/GREEN stash cycle for the two new tests; exactly the secret-bearing one failed
  pre-fix, as expected.
- Did the sweep the report format asked for — going back through every path across all four rounds
  rather than only listing this round's own change — and it surfaced two more real gaps in the
  process (bindings, nested Error), both reported here and left unfixed, per the explicit
  instruction not to chase further shapes in this task.
- `lint`/`typecheck` clean, no `any`, no `console.log`, no `process.env` access in the new code.
- Did not build the deferred lint rule.

## Concerns

1. Items 7, 8, and 9 above are real, verified, unfixed gaps in the current redaction coverage. None
   are hypothetical — each was reproduced with a real logger and real output. All three are
   documented for the whole-branch review rather than fixed here, per this round's explicit scope.
2. Given that this final sweep alone surfaced two previously-unknown gaps (bindings, nested Error),
   I'd treat the "covered" list above as accurate for the specific shapes tested, not as a
   guarantee that no further shape exists — the same caveat I raised, and then had confirmed, at
   the end of the previous round.

---

# Final round: nested-Error fix (works), child-bindings fix (does not — reporting why)

Coordinator ruling: fix both remaining items, described as "one-line applications of `redact()` /
`redactSecretsInText` to code paths that already exist." One of them is exactly that. The other
turned out not to be — the finding below is the most important thing in this report, because it
corrects a comment I had already written and committed to the working tree asserting a verification
that had not actually happened. Session was interrupted partway through and resumed; the code state
described in the resume message was accurate, and this section continues from there honestly.

## What changed

**`packages/observability/src/redaction.ts`** — the `instanceof Error` branch inside `redact()` now
runs the message through `redactSecretsInText` before returning it:

```ts
if (value instanceof Error) {
  return { name: value.name, message: redactSecretsInText(value.message) };
}
```

This is a genuine one-line fix, exactly as characterized. It works because `redact()` is a pure
function — no pino involved, no interception point to get wrong. `redactSecretsInText` was already
in scope (imported by `logger.ts`, exported from the package since round 2). Verified with a direct
test (below) and by TDD RED/GREEN.

**`packages/observability/src/logger.ts`** — added `formatters.bindings: (bindings) => redact(bindings)`,
alongside the existing `formatters.log`. This is the part that does not work as intended — see the
finding below. The code is left in place (it is correct as far as it goes, and harmless), but the
doc comment above it was rewritten from an earlier draft that overstated what it did, to instead
state exactly what was verified, with the pino source citation.

## The finding: `formatters.bindings` does not run for the call shape it was meant to protect

Before the session was interrupted, I had already written and left in the tree a comment asserting:
*"Verified directly: without this, a secret passed as a child binding... was reproduced unredacted
on every line the child ever logs, not just once."* That sentence describes the problem correctly,
but implies the fix (adding `formatters.bindings`) resolves it. On resuming, before writing any
tests, I ran the actual probe that sentence claimed to be based on — and the fix does not resolve
it. The comment was written ahead of confirming it, exactly the failure mode flagged as a risk.
Corrected in the code (the current comment states the verified truth) and reported in full here,
per the explicit instruction: *"If the comment turns out to overstate what you verified, correct the
comment."*

**What's actually true**, verified by reading `node_modules/pino/lib/proto.js`'s `child()` function
directly, then confirmed with direct probes:

```js
function child (bindings, options) {
  ...
  const instance = Object.create(this)
  if (options == null) {
    if (instance[formattersSym].bindings !== resetChildingsFormatter) {
      instance[formattersSym] = buildFormatters(
        formatters.level,
        resetChildingsFormatter,   // <- discards the parent's custom bindings formatter
        formatters.log
      )
    }
    instance[chindingsSym] = asChindings(instance, bindings)
    ...
    return instance
  }
  ...
  // even when options IS supplied, the else-branch below still defaults to
  // resetChildingsFormatter unless options.formatters.bindings is explicitly given:
  if (options.hasOwnProperty('formatters')) {
    const { level, bindings: chindings, log } = options.formatters
    instance[formattersSym] = buildFormatters(level || formatters.level, chindings || resetChildingsFormatter, log || formatters.log)
  } else {
    instance[formattersSym] = buildFormatters(formatters.level, resetChildingsFormatter, formatters.log)
  }
  ...
}
```

Pino's own `child()` — for *both* the fast path (`.child(bindings)`, no second argument, which is
exactly `logger.child({ apiKey: secret })`) and the general path (`.child(bindings, options)` unless
`options.formatters.bindings` is explicitly re-supplied on that exact call) — resets the bindings
formatter to `resetChildingsFormatter`, a plain identity function, discarding whatever the parent
logger's `formatters.bindings` was. This is a hard-coded, documented (in pino's own source comment)
performance optimization, not a bug or a version quirk. It means: no configuration passed once to
`createLogger()` can make a descendant's `.child()` bindings pass through our redaction, for any
call shape this codebase would realistically use.

Confirmed with four separate probes against the built package:

```
// Standard call — the shape this codebase will actually use:
const child = logger.child({ apiKey: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def' });
child.info('first line'); child.info('second line');
-> both lines: "apiKey":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def"   (unredacted, both times)

// With an empty options object:
logger.child({ apiKey: '...' }, {});           -> still unredacted
// With an unrelated option (level) but no formatters override:
logger.child({ apiKey: '...' }, { level: 'info' }); -> still unredacted
// Only works if the SAME formatter is re-supplied on every single .child() call:
logger.child({ apiKey: '...' }, { formatters: { bindings: sameFn } }); -> redacted, but only because
  it was passed again, defeating the purpose of configuring it once in createLogger()
```

I also re-checked the double-redaction/double-merge question the ruling asked about, since the
answer to that question is now moot for the standard call (the bindings formatter never fires) but
still relevant for the narrow case where it does fire (an explicit-options child, or the root
logger's own `base` object): a captured line from a child logger contains no trace of the bindings
object inside what `formatters.log` receives — bindings and per-line fields are assembled through
genuinely separate code paths in pino, so there is no double-redaction and no double-merge of the
ambient request context in either case. That part of the original comment was correct.

**What I did not do, and why**: I considered wrapping the returned `Logger`'s own `.child` method
in `createLogger()` to force our formatters back in on every call — that would actually close the
gap. I did not build it. It is a materially different, larger kind of change than a one-line
`redact()` application (it means intercepting and re-implementing part of the public `.child()`
contract, maintaining behavioral parity with whatever pino does with the rest of its options
argument, and it changes what the returned object is — no longer quite a plain pino `Logger`). That
crosses into exactly the category of change this task has repeatedly declined to make without
explicit authorization (see the printf-interpolation ruling in the previous round), and this is the
last authorized round. Reporting it rather than building it.

## Tests

**Added (2, both able to fail, both verified by RED/GREEN below):**

- `redaction.spec.ts`: `'text-scans the message of an Error nested anywhere in a payload'` — an
  Error under `{ context: { originalError } }`, secret in its message, asserted redacted.
- `logger.spec.ts`: `'leaves the existing top-level err message/stack redaction unchanged'` — the
  explicit regression guard the ruling asked for, confirming the nested-Error fix in `redact()`
  doesn't alter the separate top-level `err`-key pathway (`redactError()` in `logger.ts`, which
  never calls `redact()`'s `instanceof Error` branch at all — it uses `pino.stdSerializers.err` +
  its own substring redaction, so the two pathways are structurally independent; this test is the
  proof of that independence, not just an assertion of it).

**Not added — the two child-binding tests from the ruling's list:**

- `logger.child({ apiKey: 'secret' })` → redacted in the bindings, and still redacted on a second
  line.
- A child binding with no secret survives byte-identically.

Both describe the standard `.child()` call, which the finding above proves is not redacted by the
implemented fix. Writing them as specified would produce two tests that fail permanently — not a
RED that turns GREEN, a RED that *stays* red, because there is no code in this package that makes
it pass without the larger `.child`-wrapping change described above. Committing a permanently
failing test would break `pnpm test`, one of the four hard gates for every round of this task.
Writing a *passing* test that exercises a different, unrealistic call shape (e.g. explicitly
re-supplying `formatters.bindings` on every `.child()` call) to satisfy the letter of "add a
bindings test" would misrepresent what's actually protected — exactly the category of decorative or
misleading test this task has spent multiple rounds removing. I chose neither. The probe transcripts
above are the evidence in place of these two tests.

## TDD evidence

**RED**: `git stash push -- packages/observability/src/redaction.ts packages/observability/src/logger.ts`
to revert both implementation files to the previous commit (`7836f50`) while keeping both new tests,
then ran:

```
pnpm vitest run --project unit packages/observability
```

Exactly the nested-Error test failed, for the expected reason; the regression-guard test passed
either way (expected — it exercises a pathway this round's change doesn't touch):

```
x redact > text-scans the message of an Error nested anywhere in a payload
  Expected: "leaked here: [redacted]"
  Received: "leaked here: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def"
Test Files  1 failed | 1 passed (2)
     Tests  1 failed | 28 passed (29)
```

Restored (`git stash pop`) and re-ran:

**GREEN**:
```
pnpm vitest run --project unit packages/observability
 v packages/observability/src/redaction.spec.ts (13 tests)
 v packages/observability/src/logger.spec.ts (16 tests)
 Test Files  2 passed (2)
      Tests  29 passed (29)
```

(CRLF warnings appeared on both stash operations, as flagged in advance — `.gitattributes`
normalises to LF on commit; no action needed.)

## Root verification (all four commands, real output)

```
$ pnpm lint
Tasks:    3 successful, 3 total

$ pnpm typecheck
Tasks:    3 successful, 3 total

$ pnpm test
 v packages/config/src/env.spec.ts (8 tests)
 v packages/observability/src/redaction.spec.ts (13 tests)
 v packages/observability/src/logger.spec.ts (16 tests)
 Test Files  3 passed (3)
      Tests  37 passed (37)

$ pnpm build
Tasks:    2 successful, 2 total
```

## Files changed (this round)

- `packages/observability/src/redaction.ts` — `redact()`'s `instanceof Error` branch now text-scans
  `message`.
- `packages/observability/src/redaction.spec.ts` — added the nested-Error test.
- `packages/observability/src/logger.ts` — added `formatters.bindings`; rewrote its doc comment to
  state the verified (narrower than originally hoped) truth.
- `packages/observability/src/logger.spec.ts` — added the top-level-err regression guard.

`redaction.ts` is now 124 lines, `logger.ts` 213 lines, `logger.spec.ts` 162 lines,
`redaction.spec.ts` 102 lines — all still under the ~300-line constraint.

## Self-review (this round)

- The central self-review finding of this round *is* the report: I caught my own comment asserting
  a verification that hadn't happened, before writing a single test around it, and corrected both
  the comment and my plan for what to build and test as a result. That is the exact discipline this
  task has been enforcing since round 1's brief-defect finding — this time applied to my own
  half-finished work rather than someone else's.
- Did not write tests to make an unfixed gap look fixed. Confirmed this was the right call by
  actually attempting to write the two bindings tests exactly as specified and watching them fail
  against the *post-fix* code, not just the pre-fix code — that failure is what's reported above
  instead of a fabricated pass.
- Ran the full RED/GREEN cycle for both tests actually added, not just the ones that were easy.
- `lint`/`typecheck` clean, no `any`, no `console.log`, no `process.env` access in the new code.

## Coverage list — final state (supersedes the round-4 list above)

This is the definitive account for the whole-branch review. Ten items; two changed status this
round (9 moved from not-covered to covered; 8 stays not-covered, now with a corrected, complete
explanation of why the obvious fix doesn't work).

**Covered:**

1. **Structured fields in the merge-object argument passed to a log call** — key-name denylist
   (case-insensitive, substring match) plus value-shape backstop, recursive through nested objects
   and arrays, depth-capped at 12. Circular references broken with a `WeakSet`. A throwing getter is
   caught per-property and replaced with `'[unreadable]'` rather than crashing the logger.
2. **The top-level `err`/`errorKey` Error's `.message` and `.stack`** — whether passed as a bare
   Error first argument or as `{ err }`, and whether or not a separate message argument is given.
   Redacted via a custom `err` serializer (substring redaction, stack kept) plus a preemption branch
   in `hooks.logMethod` for the no-separate-argument case.
3. **The `msg` string, when supplied explicitly** — `logger.info(msg)` or `logger.info(obj, msg)`.
   Substring redaction via `hooks.logMethod`.
4. **`msg` auto-derived by pino from a bare Error/`{ err }` with no separate message argument** —
   pino's own internal fallback (`write()` in `lib/proto.js`) is preempted by supplying an explicit,
   already-redacted message before it can fire.
5. **The `pretty: true` transport path** — confirmed by direct stdout capture that every mechanism
   above runs in the main thread before the line ever reaches the `pino-pretty` transport.
6. **Child logger inheritance of `hooks`/`serializers`/`formatters.log`** — confirmed
   `logger.child({...}).error(bareErr)` redacts identically to the parent logger. (This is
   `formatters.log` inheritance, which works normally — distinct from `formatters.bindings`, item 8
   below, which does not.)
7. **An `Error` nested anywhere in a payload other than the top-level `err`/`errorKey` position** —
   e.g. `logger.info({ context: { originalError: err } }, 'msg')`. `redact()`'s `instanceof Error`
   branch now runs `message` through `redactSecretsInText` before returning it, the same treatment
   the top-level `err` key gets via a different mechanism. The stack is still intentionally dropped
   for this case (unchanged design: only the top-level `err` key has a serializer stage positioned
   to redact-and-reattach a stack; a nested Error has no equivalent stage).

**Partially covered (by design, per round 4's ruling — capped deliberately, not pursued further):**

8. **Trailing printf-style interpolation arguments** (`logger.info('token=%s', value)`) — covered
   only by the value-shape backstop (substring redaction for a string argument, structural
   `redact()` for an object argument), because the position carries no key name to match. A secret
   that isn't one of the five recognised shapes (bearer token, JWT, credentialed URL, Stripe-style
   key, PEM block) is not redacted in this position. Reimplementing pino's `%s`/`%d`/`%j`/`%o`
   semantics to redact the formatted result was explicitly ruled out.

**Not covered — attempted, does not work, explained in full above:**

9. **Child logger bindings** (`logger.child({ apiKey: secret })`) — `formatters.bindings` was added
   to `createLogger()`, but pino's own `child()` implementation resets a child's bindings formatter
   to an identity function for the ordinary single-argument call (and for a call with an `options`
   argument that doesn't itself re-specify `formatters.bindings`), discarding whatever the parent
   configured. Verified by reading pino's source (`lib/proto.js`, the `resetChildingsFormatter`
   branches) and by direct probe: a secret in a child binding is reproduced verbatim on every line
   from that child, unaffected by the fix in this codebase. This is the highest-severity item on
   this list — bindings persist across every subsequent line from a child, and `.child()` is
   expected to become this codebase's standard way of attaching `organizationId`/`requestId` per
   request. Closing it requires either wrapping the returned `Logger`'s `.child` method (a
   materially larger change, not attempted, not authorized) or a convention/lint rule prohibiting
   secrets in `.child()` bindings — the same category of fix as the deferred printf lint rule from
   round 4, and likely belongs with it.

## Concerns

1. **Item 9 (child bindings) is the most serious open gap from this entire task**, for the reason
   stated above: it is the one gap that compounds (every line from an affected child, not just one
   log call), and `.child()` is expected to be this codebase's standard mechanism for attaching
   per-request context. It needs a decision — most likely a lint rule alongside the deferred printf
   rule, or a documented convention that request-scoped context goes through
   `runWithRequestContext`/the ambient `RequestContext` (which *is* fully covered, per item 3/4/6 of
   this list) rather than through `.child()` bindings, so `.child()` is simply never used for
   anything that could carry a secret.
2. I want to be explicit that I initially wrote a code comment asserting this was fixed and verified
   before actually verifying it, during the session that was then interrupted. It was caught and
   corrected before any test was written around it or any claim was made to you about it being
   done — but it happened, and the fact that it happened is itself worth knowing, given how much of
   this task has been about not letting exactly that happen.

---

# Final round: wrapping `.child()` closes the bindings gap

Coordinator supplied the design directly rather than asking for further investigation: intercept
`.child()` itself on the returned `Logger` instance, since pino resets a child's bindings formatter
to identity in both branches of its own `child()` (verified independently by the coordinator against
the same `lib/proto.js` lines cited in the previous round) and there is no configuration-only way
around that. Implemented as sketched, verified empirically before writing any test, then tested.

## What changed

**`packages/observability/src/logger.ts`**:

- New `wrapChild(logger: Logger): Logger` — captures the logger's own inherited `child` method,
  then replaces it with an own property (`Object.defineProperty`, non-enumerable) that redacts
  `bindings` before delegating to the original via `inheritedChild.call(this, redact(bindings), options)`.
  Because pino builds every descendant with `Object.create(this)` (`lib/proto.js`), this one own
  property on the root instance is inherited down the entire prototype chain — a grandchild's
  `.child()` call resolves to this same function with `this` correctly bound to the grandchild at
  call time, so no recursion or re-wrapping is needed at each level.
- All three `createLogger` return paths (`stream` test seam, `pretty: true`, and the default case)
  now route through `wrapChild(...)` before returning.
- Two TypeScript frictions from monkey-patching a generic method, both resolved without `any`:
  pino's `child` is generic over a custom-levels type parameter that fights `.call()`'s `this`
  typing once extracted as a plain value (resolved by casting through `unknown` to the concrete,
  non-generic signature this package actually uses), and extracting a method as a value trips
  `@typescript-eslint/unbound-method` (silenced with a justification comment, since the method is
  only ever invoked via `.call(this, ...)` below it, never called unbound).
- The `formatters.bindings` doc comment was corrected again — from round 5's "does not work for
  the ordinary call, no fix without a larger change" to reflect its now-true, narrower scope: it
  covers only the root logger's own `base` bindings (`{ service }`, never secret-shaped by this
  package's design); `.child()` bindings are handled by `wrapChild` instead.

## Verified before writing any test

Built the package and ran four direct probes against the compiled logger, per the coordinator's
explicit instruction not to treat this as a research task but still confirm it actually works
before committing to it:

```
// Standard single-arg child, redacted twice:
const child = logger.child({ apiKey: 'Bearer eyJ...' });
child.info('first line'); child.info('second line');
-> both lines: "apiKey":"[redacted]"

// Grandchild via .child({a}).child({apiKey: secret}):
-> {"requestId":"req_1","apiKey":"[redacted]", ...}   // parent binding intact, secret redacted

// Non-secret binding:
logger.child({ organizationId: 'org_01J', requestId: 'req_01J' }).info('plain');
-> {"organizationId":"org_01J","requestId":"req_01J", ...}   // unchanged

// Two-argument form with an options object:
logger.child({ apiKey: secret }, { level: 'warn' });
-> level correctly set to warn (info line suppressed, warn line present, apiKey redacted)
```

Also re-checked the `pretty: true` path specifically, since both `createLogger` return branches now
go through `wrapChild`: a child created from a `pretty: true` logger, with a secret binding, showed
`apiKey: "[redacted]"` in the pretty-printed output — confirmed working, not assumed from the
non-pretty result.

## New tests (4, all in `logger.spec.ts`, mapped 1:1 to the ruling's list)

- `'redacts a secret in child logger bindings, and again on a second line from the same child'` —
  two `.info()` calls on the same child, both lines asserted redacted (the "computed once, reused"
  proof the ruling specifically asked for).
- `'redacts a secret in grandchild bindings, proving the override is inherited'` —
  `logger.child({a}).child({apiKey: secret})`, asserting both the parent's binding and the
  grandchild's secret appear correctly (one redacted, one not) in the same line.
- `'leaves a non-secret child binding byte-identical'`.
- `'still honours the two-argument child(bindings, options) form, including level'` — asserts the
  `warn`-level option takes effect (an `info` call is suppressed, only the `warn` line appears) and
  the binding is still redacted, proving the override doesn't regress the two-argument form.

**Self-check**: the first two fail if `wrapChild` is removed or if the override isn't correctly
inherited by descendants (confirmed by RED below — without the fix, both show the raw secret). The
third is a non-mangling guard, same caveat as every other "no secret" test in this task: it can't
independently prove the mechanism is engaged, only that it doesn't corrupt ordinary input. The
fourth fails if the override interferes with `ChildLoggerOptions` handling (e.g. by not forwarding
`options` to the real `child`, or by breaking pino's own level-setting logic) — this is the test
that specifically distinguishes "wraps child correctly" from "replaces child with something that
ignores its second argument."

## TDD evidence

**RED**: `git stash push -- packages/observability/src/logger.ts` to revert to the previous commit
(`5e5d66c`) while keeping all four new tests, then ran:

```
pnpm vitest run --project unit packages/observability
```

Exactly the three tests exercising an actual secret failed; the byte-identical test passed either
way, as expected:

```
x createLogger > redacts a secret in child logger bindings, and again on a second line from the same child
  Expected: "[redacted]"   Received: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def"
x createLogger > redacts a secret in grandchild bindings, proving the override is inherited
  Expected: "[redacted]"   Received: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def"
x createLogger > still honours the two-argument child(bindings, options) form, including level
  Expected: "[redacted]"   Received: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def"
Test Files  1 failed | 1 passed (2)
     Tests  3 failed | 30 passed (33)
```

Restored (`git stash pop`) and re-ran:

**GREEN**:
```
pnpm vitest run --project unit packages/observability
 v packages/observability/src/redaction.spec.ts (13 tests)
 v packages/observability/src/logger.spec.ts (20 tests)
 Test Files  2 passed (2)
      Tests  33 passed (33)
```

## Root verification (all four commands, real output)

```
$ pnpm lint
Tasks:    3 successful, 3 total

$ pnpm typecheck
Tasks:    3 successful, 3 total

$ pnpm test
 v packages/config/src/env.spec.ts (8 tests)
 v packages/observability/src/redaction.spec.ts (13 tests)
 v packages/observability/src/logger.spec.ts (20 tests)
 Test Files  3 passed (3)
      Tests  41 passed (41)

$ pnpm build
Tasks:    2 successful, 2 total
```

## Files changed (this round)

- `packages/observability/src/logger.ts` — added `wrapChild`, wired into all three return paths,
  extended the `pino` type import, corrected the `formatters.bindings` comment.
- `packages/observability/src/logger.spec.ts` — added the four tests above.

`logger.ts` is now 255 lines, `logger.spec.ts` 206 lines — both still under the ~300-line
constraint, though `logger.ts` is now the closest to it of any file in the package.

## Self-review (this round)

- Verified the design against the real, built package with direct probes *before* writing a single
  test, specifically because the previous round's mistake was writing a claim before verifying it —
  did not repeat that.
- Checked the `pretty: true` path specifically for this fix too, rather than assuming it inherited
  correctness from the non-pretty case, since both branches route through the same `wrapChild` call
  but are still structurally different pino configurations.
- Confirmed the two TypeScript workarounds (the `unknown` cast, the `unbound-method` disable) are
  both narrowly scoped and carry a specific justification, not blanket suppressions.
- `lint`/`typecheck` clean, no `any`, no `console.log`, no `process.env` access in the new code.

## Coverage list — final state (supersedes both earlier versions)

Ten items, unchanged in count from the previous round, but item 9 moves from **not covered** to
**covered** — the only remaining non-full item is 8 (printf interpolation), capped deliberately by
explicit ruling in round 4, not a residual defect.

**Covered:**

1. **Structured fields in the merge-object argument passed to a log call** — key-name denylist
   (case-insensitive, substring match) plus value-shape backstop, recursive through nested objects
   and arrays, depth-capped at 12. Circular references broken with a `WeakSet`. A throwing getter is
   caught per-property and replaced with `'[unreadable]'` rather than crashing the logger.
2. **The top-level `err`/`errorKey` Error's `.message` and `.stack`** — whether passed as a bare
   Error first argument or as `{ err }`, and whether or not a separate message argument is given.
3. **The `msg` string, when supplied explicitly** — `logger.info(msg)` or `logger.info(obj, msg)`.
4. **`msg` auto-derived by pino from a bare Error/`{ err }` with no separate message argument** —
   preempted before pino's own fallback can fire.
5. **The `pretty: true` transport path** — confirmed by direct stdout capture, for every mechanism
   in this list including the round-6 child-bindings fix specifically.
6. **Child logger inheritance of `hooks`/`serializers`/`formatters.log`** — pino's normal, built-in
   inheritance behaviour, which already worked without any fix from this package.
7. **An `Error` nested anywhere in a payload other than the top-level `err`/`errorKey` position** —
   `redact()`'s `instanceof Error` branch now text-scans `message` via `redactSecretsInText`. The
   stack is still intentionally dropped for this case (only the top-level `err` key has a serializer
   stage positioned to redact-and-reattach a stack).
8. **Child logger bindings** (`logger.child({ apiKey: secret })`, including chained/grandchild
   children, and both the one- and two-argument call forms) — `.child()` itself is wrapped on the
   returned `Logger` instance to redact bindings before delegating to pino's real implementation,
   since pino's own `child()` resets any root-configured `formatters.bindings` to an identity
   function for every call shape and there is no way to close this through configuration alone.
   Verified with a real logger for the standard call, a grandchild, the two-argument form, and under
   `pretty: true`. This was the highest-severity item on the list in the previous round (bindings
   persist across every subsequent line from a child) and is now closed.

**Partially covered (by explicit ruling, capped deliberately — not a residual defect):**

9. **Trailing printf-style interpolation arguments** (`logger.info('token=%s', value)`) — covered
   only by the value-shape backstop (substring redaction for a string argument, structural
   `redact()` for an object argument), because the position carries no key name to match. A secret
   that isn't one of the five recognised shapes (bearer token, JWT, credentialed URL, Stripe-style
   key, PEM block) is not redacted in this position. Reimplementing pino's `%s`/`%d`/`%j`/`%o`
   semantics to redact the formatted result was explicitly ruled out as a worse failure mode than
   the residual gap. A lint rule banning printf-style calls on this logger was identified as the
   real fix for this class and deliberately deferred to the lint task / whole-branch review, not
   built here.

Nine numbered items above; there is no item 10 in this final version — the previous round's
provisional list had a 10th "not covered" entry for child bindings, which is now item 8 above,
covered.

## Concerns

1. **None of the remaining items are open defects.** Item 9 (printf interpolation) is a deliberately
   capped, explicitly ruled residual — not something left unfinished. Every other path probed across
   all six rounds of this task is fully covered.
2. The deferred lint rule (banning printf-style calls on this logger) from round 4 remains
   unbuilt, by design, for the lint task or whole-branch review to pick up.
3. `logger.ts` at 255 lines is the largest file in the package and now carries five distinct
   redaction mechanisms (`formatters.log`, the `err` serializer, `hooks.logMethod`'s message/
   interpolation handling, `formatters.bindings`, and `wrapChild`). Each is individually documented
   and tested, but a future maintainer extending this file should read the existing comments
   carefully before assuming a single obvious insertion point — the ordering and interaction between
   these five mechanisms (particularly which one runs before which, established by reading pino's
   own source across six rounds) is load-bearing, not incidental.

---

# Review round: three Critical, two promoted Important, and one documentation fix

A whole-branch reviewer rebuilt the package and ran roughly 40 probes against the compiled logger
directly, reproducing rather than reasoning about each finding. It confirmed a long list of things
built across the six prior rounds hold up under adversarial probing — Symbol keys, prototype chains,
`err.cause`, `AggregateError`, the depth boundary, circular graphs, null-prototype objects, the
entire `wrapChild` surface (level, `bindings()`, `flush`, grandchildren, `pretty:true`), and no
ReDoS — and found three Critical defects, two Important findings promoted to fix now, and confirmed
the reviewer's own sharpest structural point: every crash-safety property had only ever been tested
against `redact()` directly, never through `createLogger`, which is exactly why one of the three
Criticals (I4) survived six rounds undetected.

## Critical fixes

**C1 — `logger.error(err, undefined)` leaked the raw message.** `src/logger.ts`

The single-argument preemption added in round 3 was gated on `inputArgs.length === 1`. An explicit
`undefined` second argument — `logger.error(err, exception.message)` when that message happens to be
absent, exactly the shape Task 9's error filter would produce — makes `length === 2`, falls through
the gate untouched, and lets pino's own fallback fire with the raw message. Regated on whether a
string message is actually present (`typeof inputArgs[1] !== 'string'`) rather than on argument
count, so an explicit `undefined` is caught the same as an omitted argument.

**C2 — an own-enumerable `toJSON` resurrected everything redacted, at any depth, through the key
that matched the denylist.** `src/redaction.ts`

`redact()` passed function values through unchanged (they are neither strings nor plain objects), so
a nested object with its own `toJSON()` method survived the walk with that method intact — and
pino's `JSON.stringify` calls `toJSON()` during serialisation, using its return value instead of the
already-redacted object, undoing the redaction after the fact:
```
logger.info({ a: { b: { toJSON() { return { token: SECRET }; } } } }, 'x')
→ "a":{"b":{"token":"Bearer eyJhbGci…"}}
```
The key here is literally `token`, a primary denylist fragment — this defeated key-name matching,
not only the value-shape backstop. Fixed by dropping own-enumerable function-valued properties
during the object walk. A prototype-based `toJSON` (Date, URL, class instance methods) is
unaffected, since `Object.keys()` never sees an inherited method; JSON serialisation already drops a
bare function property at the top level regardless, so nothing legitimate is lost by dropping it
during the walk instead.

**C3 — a non-string `Error.message` crashed the logger.** `src/redaction.ts`

`redactSecretsInText` called `.replace()` on its argument with no type guard. A message reassigned
to a non-string (`err.message = 12345`, reachable via plain assignment since `message` is a normal
writable own property, not just via a hostile getter) threw out of both `logger.info(...)` and
`logger.error(...)`, into the caller — on the error-reporting path specifically, which is exactly
what the getter-safety guard (round 1) exists to prevent, and this bypassed it entirely since it
isn't a getter throwing, it's a plain value of the wrong type. Also directly relevant to Task 9:
`redactSecretsInText` is an exported function its error filter is expected to call, so a non-string
reaching it there would crash the filter itself. Fixed by widening the parameter to `unknown` and
failing closed: `if (typeof text !== 'string') return REDACTED;`. Deliberately not `String(text)` —
a hostile `toString`/`Symbol.toPrimitive` can itself throw, which reintroduces the exact crash this
exists to prevent.

## Important fixes (promoted from the deferred list)

**I4 — the throwing-getter guard didn't cover the position most likely to be hit.** `src/logger.ts`

`formatters.log` built its `rest` object with `const { [ERROR_KEY]: topLevelError, ...rest } =
object`. Rest-destructuring reads every remaining own-enumerable property up front to build the
rest object — including invoking a throwing getter — before `redact()`'s own try/catch ever runs.
A throwing getter one level down inside a nested object was already caught (redact()'s own guard);
a throwing getter at the top level of the object passed directly to a log call — the most realistic
position for calling code to hit — was not. Fixed by building `rest` with the same guarded
try/catch-per-key walk `redact()` uses internally, instead of a bare rest-destructure. (One
observable side effect: an object that references itself directly at the very top level of a log
call — `obj.self === obj`, handed straight to `logger.info(obj, msg)` — now shows one extra level of
nesting before the `'[circular]'` marker appears, e.g. `{ name: 'x', self: { name: 'x', self:
'[circular]' } }` instead of `{ name: 'x', self: '[circular]' }`, because the guarded copy is a new
object with its own identity separate from the original. A genuinely nested cycle — the realistic
shape, and the one now tested — is unaffected; this is a minor shape difference on an unusual input,
not a correctness or safety issue, and not one of the numbered findings below.)

**M9 (promoted) — the context-merge comment asserted the opposite of what the code did.**
`src/logger.ts`

`return context === undefined ? redacted : { ...context, ...redacted };` let any log-call field with
the same name as a correlation ID (`requestId`, `organizationId`, `traceId`, `userId`) silently
override it, because object-spread lets the later operand win and `redacted` (the log-call's own
fields) was spread last. The round-1 report explicitly claimed this ordering prevented exactly that
override — it asserted the opposite of the actual behaviour. Fixed by spreading `context` last, so
correlation IDs always win a key collision, and rewrote the comment to state what the code now does
rather than repeat the earlier, incorrect claim. A caller able to shadow `requestId` breaks audit
correlation, which is the entire reason these fields are threaded through `AsyncLocalStorage` in the
first place.

**M8 (Date only, promoted) — Date silently serialised to `{}`.** `src/redaction.ts`

`Date` has no own enumerable properties, so the generic object walk reduced every `Date` value to an
empty object — a real regression against stock pino, and dates are common in log payloads
(timestamps, expiries, scheduled-for fields). Fixed with an explicit branch: `if (value instanceof
Date) return value.toISOString();`, preserving the same string a plain `JSON.stringify` would have
produced. `Map`/`Set`/`Buffer` are left as-is and recorded in the coverage list below rather than
also special-cased, per the instruction to scope this fix to Date only.

## Documentation changes (no behaviour change)

- `createLogger` now has a docblock. It previously had none; the printf-interpolation residual
  (accurate content, wrong location — it lived inside an inline comment attached to `hooks:`) is
  relocated there, since a docblock on the function itself is where a reader — and Task 9 — will
  actually look for "what does this cover and what doesn't it."
- `redactError`'s docblock now states I5 (below) directly, at the one place a future reader is
  most likely to be extending exactly the code path I5 describes.
- `SECRET_KEY_FRAGMENTS`'s docblock is unchanged — M10 (below) is about that list's own precision,
  deferred, not fixed this round.

## New residuals recorded, not fixed (I5, I6)

**I5 — a caller-registered `err` serializer bypasses `redactError` entirely.** `formatters.log`
hands a real, raw `Error` downstream under the assumption that some `err` serializer will run on
it — that assumption holds only because `serializers.err` is set to `redactError` in this file. A
caller who creates a child with their own `serializers: { err: ... }` (a legitimate, documented pino
API) replaces `redactError` for that child and its descendants, and nothing else in this package
redacts the raw Error's message/stack in that case. Documented in `redactError`'s docblock and in
the coverage list below; not fixed — closing it would mean either preventing serializer overrides
(a real behaviour change to a documented pino API this package doesn't own) or moving the
message/stack redaction earlier into `formatters.log` itself (a larger restructuring not undertaken
without a ruling, in keeping with this task's pattern of not chasing pino's internals unbidden).

**I6 — a secret embedded in a key name is emitted verbatim.** `keyIsSecret()` matches a key against
a small denylist of fragments (`password`, `token`, ...); it was never intended to, and does not,
run a key through the value-shape backstop (`valueLooksSecret`/`redactSecretsInText`). A payload
keyed by the secret itself — `logger.info({ [apiKeyValue]: 'active' })`, an unusual but possible
shape (e.g. a lookup table keyed by API key) — leaks the key text unredacted, since object keys are
always emitted as-is and only the values under them are structurally redacted. Recorded in the
coverage list; not fixed, since running every key through the full backstop pattern set on every
object in every log line is a real cost/behaviour trade-off that wasn't part of this review's scope
to decide unilaterally.

## Deferred, confirmed not fixed (M7, M10, M11)

Recorded here for the whole-branch review, per explicit instruction not to fix them in this round:

- M7 — `redact()`'s `WeakSet`-based cycle guard mislabels a shared, non-circular reference (the same
  object reachable twice in a payload without an actual cycle, e.g. `{ a: shared, b: shared }`) as
  `'[circular]'` on its second occurrence. Imprecise but safe — no crash, no infinite loop, no
  leaked secret, just a label that overstates what was found.
- M10 — four of the thirteen entries in `SECRET_KEY_FRAGMENTS` are dead after the
  underscore-stripping/substring-containment logic in `keyIsSecret()`: `api_key` (redundant with
  `apikey` once underscores are stripped), `private_key` (redundant with `privatekey`, same reason),
  `session_id` (redundant with `sessionid`, same reason), and `mfasecret` (redundant with `secret`
  alone, since `'mfasecret'.includes('secret')` is already true — no underscore involved). The
  docblock's `Source list: .claude/operations/monitoring.md §2` citation is also imprecise in both
  directions: this list both adds entries beyond that doc's canonical set (`passwd`, `apikey`/
  `api_key`, `privatekey`/`private_key`, `sessionid`/`session_id`, `mfasecret`) and omits one the
  doc has — a standalone `key` fragment. None of this changes redaction behaviour (the dead entries
  are harmless duplicates, not gaps), but the list and its citation should be cleaned up together
  rather than picked at piecemeal.
- M11 — was the duplicate test at the old `src/logger.spec.ts:153-161`. Resolved by deletion (see
  Tests, below) rather than deferred, since the coordinator's instruction was conditional on that
  choice ("M11 if you delete the duplicate").

## Tests

Deleted the duplicate test the reviewer flagged (`'leaves the existing top-level err message/stack
redaction unchanged'`), which asserted exactly the same two facts — `err.message` redacted,
`err.stack` redacted and stripped of the raw secret — already covered by the round-2/3 tests at what
were then lines 68-74 and 84-93, with no distinct failure mode of its own.

Added eight tests to `logger.spec.ts`, addressing the reviewer's sharpest point directly: every one
below goes through `createLogger`/a real `Logger`, not `redact()` in isolation, which is what let I4
survive six rounds while `redact()`'s own getter-safety test (round 1) kept passing the whole time.

- Throwing getter at the top level of the merge object — `logger.info(hostileObj, msg)` where the
  first-argument object itself has a throwing getter (not one nested inside it). This is exactly the
  position I4 fixes and the round-1 test never reached.
- Circular reference reaching the logger — a genuinely nested cycle (`{ nested: circular }` where
  `circular.self === circular`), asserted not to throw and to serialise as `'[circular]'` at the
  expected position. (An earlier draft of this test used a cycle at the object's own top level and
  got a different, still-correct shape — see the I4 write-up above; rewritten to test the realistic
  nested case instead of asserting on the edge case.)
- Null-prototype object reaching the logger — `Object.create(null)` with an own property, logged
  directly, asserted not to throw and the property to come through unchanged.
- Non-string `Error.message` (C3) — `err.message` reassigned to a number, logged via
  `logger.error(err)` (exercising both the C1 preemption path and the `err` serializer path in the
  same call), asserted not to throw and both `msg` and `err.message` to come back as `REDACTED`
  rather than the raw number or a crash.
- C1 — `logger.error(err, undefined)` with a secret in `err.message`, asserted redacted in both
  `msg` and `err.message`, matching the exact call shape from the finding.
- C2 — the `toJSON`-resurrection payload from the finding, asserted the nested value comes back as
  `{}` (the function dropped, nothing to resurrect) rather than the secret the hostile `toJSON`
  would have returned.
- M9 — a log-call field named `requestId` inside an active `runWithRequestContext`, asserted the
  ambient `requestId`/`organizationId` win, not the log-call's own field.

Self-check (what change would make each fail): each of the six Critical/Important-mapped tests fails
if its corresponding fix is reverted — confirmed by RED below, not asserted. The throwing-getter and
null-prototype tests fail if I4 (or the underlying try/catch pattern) is removed or broken. The
circular-reference and null-prototype tests are, like earlier "no secret" tests in this task, unable
to independently prove a fix exists (they passed against the pre-review code too, since top-level
circularity and null-prototype handling were never broken — only the throwing-getter guard was) —
included because the coordinator asked for all four crash-safety properties tested at the logger
level, and two of the four were already correct there; the RED run below shows precisely which three
of these eight failed pre-fix and which did not, rather than asserting it.

## TDD evidence

RED: `git stash push -- packages/observability/src/redaction.ts packages/observability/src/logger.ts`
to revert both implementation files to the previous commit (`5bcc473`) while keeping all eight new
tests (and the duplicate-test deletion), then ran:

```
pnpm vitest run --project unit packages/observability
```

Five of the eight new tests failed, each for the expected reason; three passed against the
pre-review code because the property they test was never broken (only I4's specific gap was):

```
x does not crash on a throwing getter at the top level of the merge object
  'Error: getter exploded' was thrown
x does not crash on a non-string Error.message (C3)
  'TypeError: result.replace is not a function' was thrown
x redacts Error.message when logged with an explicit undefined second argument (C1)
  Received: "auth failed: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def"  (raw secret, unredacted)
x drops an own-enumerable toJSON so it cannot resurrect an already-redacted subtree (C2)
  Received: { token: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def" }   (resurrected)
x does not let a log-call field shadow the ambient request context (M9)
  Received: "attacker-controlled"   (shadowed the real requestId)
Test Files  1 failed | 1 passed (2)
     Tests  5 failed | 34 passed (39)
```

Restored (`git stash pop`) and re-ran:

GREEN:
```
pnpm vitest run --project unit packages/observability
 - packages/observability/src/redaction.spec.ts (13 tests)
 - packages/observability/src/logger.spec.ts (26 tests)
 Test Files  2 passed (2)
      Tests  39 passed (39)
```

## Root verification (all four commands, real output)

```
$ pnpm lint
Tasks:    3 successful, 3 total

$ pnpm typecheck
Tasks:    3 successful, 3 total

$ pnpm test
 - packages/config/src/env.spec.ts (8 tests)
 - packages/observability/src/redaction.spec.ts (13 tests)
 - packages/observability/src/logger.spec.ts (26 tests)
 Test Files  3 passed (3)
      Tests  47 passed (47)

$ pnpm build
Tasks:    2 successful, 2 total
```

## Files changed (this round)

- `packages/observability/src/redaction.ts` — C2 (drop function-valued properties), C3 (fail-closed
  `redactSecretsInText`), M8 (Date to ISO string).
- `packages/observability/src/redaction.spec.ts` — unchanged this round (all new tests are
  logger-level, per the reviewer's own finding about where the gap was).
- `packages/observability/src/logger.ts` — C1 (gate on message type, not argument count), I4
  (guarded top-level walk), M9 (context-last spread order, corrected comment), `createLogger`
  docblock (printf residual relocated), I5 note on `redactError`.
- `packages/observability/src/logger.spec.ts` — deleted the M11 duplicate, added eight tests.

`redaction.ts` is now 150 lines; `logger.ts` is 308 lines, `logger.spec.ts` 283 lines,
`redaction.spec.ts` unchanged at 102. `logger.ts` is slightly over the ~300-line guideline (by 8
lines) after this round's additions — flagged in Concerns below rather than trimmed under pressure,
since every comment in it has been individually reviewed and cited across six rounds and I did not
want to risk cutting one for a line count this close to the guideline's own "~".

## Self-review (this round)

- Ran the RED/GREEN stash cycle for all eight new tests together, not assuming which would fail —
  the three that passed pre-fix are reported as such rather than presented as if every test proved a
  gap closed.
- Caught my own first draft of the circular-reference test asserting the wrong shape (an artefact of
  I4's guarded-copy introducing an extra object hop for a very specific edge case — a top-level
  self-reference), diagnosed why before "fixing" the test, and rewrote the test to cover the
  realistic nested-cycle case instead of chasing the edge case into a new, narrower assertion.
- Verified C1's fix doesn't regress the two-argument explicit-message shape (already covered by an
  existing round-3 test, re-run clean) and doesn't accidentally swallow a legitimate non-string
  second argument used for some other purpose — the gate only fires inside the `first instanceof
  Error` / `isRecord(first) && err instanceof Error` branches, so a plain `logger.info('msg', 5)`
  (printf-style, first arg a string) is untouched by this change.
- Confirmed `lint`/`typecheck` are clean with no new `any`, no `console.log`, no `process.env` access.

## Coverage list — final state (supersedes all earlier versions)

Twelve numbered items: nine covered, one partially covered by deliberate ruling, two new documented
residuals (I5, I6).

Covered:

1. Structured fields in the merge-object argument passed to a log call — key-name denylist
   (case-insensitive, substring match) plus value-shape backstop, recursive through nested objects
   and arrays, depth-capped at 12. Circular references broken with a `WeakSet` (see M7, deferred,
   for a known imprecision in this guard's labelling — not a safety issue). A throwing getter is
   caught and replaced with `'[unreadable]'` at every depth including the top level of the object
   passed directly to a log call (fixed this round — I4; previously only nested getters were
   caught). An own-enumerable function-valued property, including one named `toJSON`, is dropped
   during the walk rather than passed through, so it cannot resurrect an already-redacted subtree at
   serialisation time (fixed this round — C2). A `Date` is preserved as an ISO string rather than
   reduced to `{}` (fixed this round — M8; `Map`/`Set`/`Buffer` are not special-cased, unchanged).
2. The top-level `err`/`errorKey` Error's `.message` and `.stack` — whether passed as a bare Error
   first argument or as `{ err }`, and whether or not a separate message argument is given,
   including an explicit `undefined` (fixed this round — C1; previously an explicit `undefined`
   second argument bypassed the preemption gate and leaked the raw message).
3. The `msg` string, when supplied explicitly — `logger.info(msg)` or `logger.info(obj, msg)`.
4. `msg` auto-derived by pino from a bare Error/`{ err }` with no separate message argument —
   preempted before pino's own fallback can fire, now including the explicit-`undefined` shape
   (item 2, C1).
5. The `pretty: true` transport path — confirmed by direct stdout capture for every mechanism above,
   and independently re-confirmed by the reviewer's own probes this round.
6. Child logger inheritance of `hooks`/`serializers`/`formatters.log` — pino's normal, built-in
   inheritance behaviour.
7. An `Error` nested anywhere in a payload other than the top-level `err`/`errorKey` position —
   `redact()`'s `instanceof Error` branch text-scans `message` via `redactSecretsInText`, which now
   also fails closed on a non-string message (C3) instead of crashing. The stack is still
   intentionally dropped for this case (unchanged design).
8. Child logger bindings — `.child()` is wrapped to redact bindings before delegating to pino's real
   implementation, covering the standard call, chained/grandchild children, the two-argument form,
   and `pretty: true`.
9. A caller-controlled log-call field cannot shadow the ambient request context — `requestId`,
   `organizationId`, `traceId`, `userId` always come from `AsyncLocalStorage`, never from a log
   call's own fields, even if a call supplies a field with the same name (fixed this round — M9;
   previously the reverse was true, and the round-1 report incorrectly claimed the opposite of the
   actual pre-fix behaviour).

Partially covered (by explicit ruling, capped deliberately — not a residual defect):

10. Trailing printf-style interpolation arguments (`logger.info('token=%s', value)`) — covered only
    by the value-shape backstop, because the position carries no key name to match. A lint rule
    banning printf-style calls on this logger remains the identified real fix, deliberately deferred
    to the lint task / whole-branch review.

Not covered — documented residuals, not fixed (new this round):

11. I5 — a caller-registered `err` serializer bypasses `redactError`. `formatters.log` hands a raw
    `Error` downstream on the assumption that some `err` serializer will redact it; a child logger
    created with its own `serializers: { err: ... }` replaces `redactError` and nothing else redacts
    that child's top-level errors.
12. I6 — a secret embedded in a key name, rather than a value, is emitted verbatim. Key names are
    matched against the fragment denylist but never run through the value-shape backstop.

## Concerns

1. `logger.ts` is 308 lines, 8 over the ~300-line guideline, after this round's necessary additions
   (I4's guarded walk, C1's revised gate logic and comment, the `createLogger` docblock, the I5
   note). Flagged rather than trimmed under time pressure — every comment in the file has been
   individually reviewed and cited across the six rounds of this task, and cutting one to hit an
   exact line count felt like a worse trade than a small, documented overage.
2. I5 and I6 are real, if narrower, residuals. Neither is hypothetical — I5 is reachable through a
   documented pino API (`serializers` on `.child()` options) this package doesn't prevent a caller
   from using; I6 is reachable by any payload that happens to use a secret as an object key.
   Recorded, not fixed, per this round's explicit scope.
3. M7, M10, M11 (closed) recorded for the whole-branch review, per explicit instruction not to fix
   them here. None of the three is a security defect — M7 and M10 are precision issues in auxiliary
   guards/documentation, M11 was resolved by test deletion.
4. This task has now gone through seven rounds plus one independent review round. I have no reason
   to believe further probing wouldn't find something else — the review round itself found three
   Criticals in code that had already passed six rounds of self-directed investigation — but I also
   have no specific unresolved suspicion of my own to report beyond what's listed above. That
   distinction (no known gap vs. no gap exists) is the honest way to leave this.

---

# Re-review: C3 was not actually fixed — the crash moved, not closed

Re-review confirmed C1, C2, I4, M9, and M8-Date all address what they claimed to, independently
reproduced against the compiled logger. It also upheld the judgement call on the rewritten
circular-reference test (extra nesting on a self-referencing top-level object is a cosmetic
consequence of I4's guarded copy — no crash, no recursion, no leak). But C3 was found still open:
the guard from the previous round is in the right function, but the crash originates one step
earlier than that guard, so it never runs.

## What was actually wrong, and what I found when I tried to reproduce it

The previous round's fix wrapped only `pino.stdSerializers.err(error)` in a try/catch. The
reviewer's diagnosis was that `stdSerializers.err` itself throws when reading `error.stack` (a lazy
V8 accessor whose first access runs `Error.prepareStackTrace` → `Error.prototype.toString()` →
`ToString(this.message)`, which throws for a Symbol message or a hostile `toString`).

I rebuilt the package and reproduced the crash with that narrower guard in place — it still threw,
confirming the finding — and then read the actual stack trace of the escaping exception rather than
guessing why the guard didn't catch it:

```
TypeError: Cannot convert a Symbol value to a string
    at Error.toString (<anonymous>)
    at defaultPrepareStackTrace (node:internal/errors:106:19)
    at Error.ErrorPrepareStackTrace (node:internal/errors:169:10)
    at prepareStackTraceCallback (node:internal/errors:150:29)
    at Object.redactError [as err] (.../logger.js:78:22)   <- inside MY destructuring, not inside stdSerializers.err
```

The actual mechanism is more specific than "stdSerializers.err throws": `pino-std-serializers`' own
`isErrorLike(err)` check is `typeof err.message === 'string'`. For a Symbol message or an
object-with-a-throwing-`toString`, that check is `false` — so `stdSerializers.err` doesn't throw at
all; it short-circuits and returns the raw, unmodified `Error` back, `.stack` still an unresolved
lazy accessor. The crash then happened one line later, in *my own* code — the destructuring `const
{ message, stack, ...extra } = serialized` — which reads `.stack` for the first time, triggering the
exact `prepareStackTrace` → `toString` → `ToString(message)` chain the reviewer described, just one
step downstream of where the previous fix's try/catch ended.

## Fix

Widened the try/catch to wrap the whole conversion — the `stdSerializers.err` call, the
destructuring, and the redaction of the result — rather than only the first step, so it fails closed
regardless of which specific step throws for a given hostile input:

```ts
try {
  const serialized = pino.stdSerializers.err(error);
  const { message, stack, ...extra } = serialized;
  return { ...(redact(extra) as Record<string, unknown>), message: redactSecretsInText(message), stack: redactSecretsInText(stack) };
} catch {
  return { type: 'Error', message: REDACTED, stack: REDACTED };
}
```

The fallback uses only literals (`'Error'`, `REDACTED`) — per the standing instruction, `error.name`
or `error.constructor.name` could themselves be hostile getters, so nothing is read from `error` in
the catch branch at all.

## Documentation corrections

**The C2 comment overstated what "nothing legitimate is lost" covers.** It grouped `URL` with
`Date` as if both were fine — they aren't. `Date` is fine because it's special-cased above (M8);
`URL` isn't special-cased and still collapses to `{}` under the generic object walk, for the same
underlying reason `Date` used to before M8. This is pre-existing, not caused by the C2 diff, and was
never claimed as covered anywhere else — so per instruction, the `URL` behaviour itself is untouched;
only the comment's false claim about it is corrected, distinguishing "a *prototype*-based `toJSON`
(a class instance method) is genuinely untouched" from "`Date` is fine because it's special-cased,
`URL` is not and still degrades."

**Coverage-list item 2 was optimistic.** It read as if the top-level `err` path no longer crashes on
a non-string message at all — true for a plain non-string like a number (the existing round-7 test),
not true for a Symbol or a hostile-`toString` value until this round's fix. Corrected below. Item 7's
narrower claim (the nested-Error case) was already accurately scoped and is unchanged.

**`URL` added to the coverage list as a residual**, alongside `Map`/`Set`/`Buffer` — same failure
shape as M8, for a type M8 deliberately didn't cover.

## Tests

Four new tests in `logger.spec.ts`, one per (message-hazard × call-shape) combination specified:

- Symbol message via a bare `Error` — `logger.error(err)`.
- Symbol message via `{ err }` — `logger.error({ err }, 'context msg')`.
- Hostile-`toString` message via a bare `Error` — `logger.error(err)`.
- Hostile-`toString` message via `{ err }` — `logger.error({ err }, 'context msg')`.

Each asserts no throw escapes, `err.type`/`err.message`/`err.stack` all come back as the safe
fallback values (`'Error'`/`REDACTED`/`REDACTED`), and — for the `{ err }` shape, where a genuine
non-secret context message was supplied — that the explicit message (`'context msg'`) is preserved
unredacted, proving the fallback doesn't also clobber an unrelated, perfectly fine `msg`.

The existing round-7 test (`'does not crash on a non-string Error.message (C3)'`, using a plain
number) remains valid and is not redundant with these four: a number's `ToString` conversion
succeeds silently (`ToString(12345)` = `"12345"`, no throw), so that test never actually exercised
the `isErrorLike`-short-circuit-then-throwing-`ToString` mechanism this round's four tests target —
it tests a genuinely different code path (the original, narrower C3 finding: a non-string value
reaching `redactSecretsInText`'s own `.replace()` call directly), which is why it didn't already
catch this.

## TDD evidence

RED: `git stash push -- packages/observability/src/logger.ts packages/observability/src/redaction.ts`
to revert to the previous commit (`fbbf0c8`, which has the narrower, still-broken C3 guard) while
keeping the four new tests, then ran:

```
pnpm vitest run --project unit packages/observability
```

All four new tests failed, each with the exact escaping exception the finding described:

```
x does not crash on a Symbol Error.message via a bare Error (C3)
  'TypeError: Cannot convert a Symbol value to a string' was thrown
x does not crash on a Symbol Error.message via { err } (C3)
  'TypeError: Cannot convert a Symbol value to a string' was thrown
x does not crash on a hostile-toString Error.message via a bare Error (C3)
  'Error: hostile toString' was thrown
x does not crash on a hostile-toString Error.message via { err } (C3)
  'Error: hostile toString' was thrown
Test Files  1 failed | 1 passed (2)
     Tests  4 failed | 39 passed (43)
```

Restored (`git stash pop`) and re-ran:

GREEN:
```
pnpm vitest run --project unit packages/observability
 - packages/observability/src/redaction.spec.ts (13 tests)
 - packages/observability/src/logger.spec.ts (30 tests)
 Test Files  2 passed (2)
      Tests  43 passed (43)
```

## Root verification (all four commands, real output)

```
$ pnpm lint
Tasks:    3 successful, 3 total

$ pnpm typecheck
Tasks:    3 successful, 3 total

$ pnpm test
 - packages/config/src/env.spec.ts (8 tests)
 - packages/observability/src/redaction.spec.ts (13 tests)
 - packages/observability/src/logger.spec.ts (30 tests)
 Test Files  3 passed (3)
      Tests  51 passed (51)

$ pnpm build
Tasks:    2 successful, 2 total
```

## Files changed (this round)

- `packages/observability/src/logger.ts` — widened `redactError`'s try/catch to cover the whole
  conversion, not just `stdSerializers.err`; rewrote the catch comment with the actual mechanism.
- `packages/observability/src/redaction.ts` — corrected the C2 comment's `URL`/`Date` claim.
- `packages/observability/src/logger.spec.ts` — added the four tests above.

## Coverage list — final state (supersedes all earlier versions)

Same twelve numbered items as the previous round; items 1 and 2 updated to the post-fix truth, and
`URL` added as a named residual inside item 1.

Covered:

1. Structured fields in the merge-object argument passed to a log call — key-name denylist
   (case-insensitive, substring match) plus value-shape backstop, recursive through nested objects
   and arrays, depth-capped at 12. Circular references broken with a `WeakSet` (see M7, deferred).
   A throwing getter is caught and replaced with `'[unreadable]'` at every depth including the top
   level of the object passed directly to a log call (I4). An own-enumerable function-valued
   property, including one named `toJSON`, is dropped during the walk rather than passed through
   (C2) — a *prototype*-based `toJSON` (a class instance method) is genuinely untouched by this,
   since `Object.keys` never sees it, but that is not a general guarantee about every
   prototype-`toJSON` type: `Date` is preserved as an ISO string because it is explicitly
   special-cased (M8); `URL` is not special-cased and still collapses to `{}` under the generic
   walk, for the same reason `Date` used to before M8 — a residual, alongside `Map`/`Set`/`Buffer`,
   not fixed this round.
2. The top-level `err`/`errorKey` Error's `.message` and `.stack` — whether passed as a bare Error
   first argument or as `{ err }`, whether or not a separate message argument is given including an
   explicit `undefined` (C1), and now including a message value whose conversion to a string itself
   throws — a `Symbol` or an object with a hostile `toString` (C3, this round; the previous round's
   fix guarded the wrong step and the crash still escaped for exactly these two shapes). A plain
   non-string message (e.g. a number) was already safe as of the previous round and remains so.
3. The `msg` string, when supplied explicitly — `logger.info(msg)` or `logger.info(obj, msg)`.
4. `msg` auto-derived by pino from a bare Error/`{ err }` with no separate message argument —
   preempted before pino's own fallback can fire.
5. The `pretty: true` transport path — confirmed by direct stdout capture for every mechanism above.
6. Child logger inheritance of `hooks`/`serializers`/`formatters.log` — pino's normal, built-in
   inheritance behaviour.
7. An `Error` nested anywhere in a payload other than the top-level `err`/`errorKey` position —
   `redact()`'s `instanceof Error` branch text-scans `message` via `redactSecretsInText`, which
   fails closed on a non-string message instead of crashing (this item's claim was already
   correctly scoped to this narrower case and needed no correction). The stack is still
   intentionally dropped for this case.
8. Child logger bindings — `.child()` is wrapped to redact bindings before delegating to pino's real
   implementation, covering the standard call, chained/grandchild children, the two-argument form,
   and `pretty: true`.
9. A caller-controlled log-call field cannot shadow the ambient request context — `requestId`,
   `organizationId`, `traceId`, `userId` always come from `AsyncLocalStorage`, never from a log
   call's own fields.

Partially covered (by explicit ruling, capped deliberately — not a residual defect):

10. Trailing printf-style interpolation arguments (`logger.info('token=%s', value)`) — covered only
    by the value-shape backstop, because the position carries no key name to match.

Not covered — documented residuals, not fixed:

11. I5 — a caller-registered `err` serializer bypasses `redactError`.
12. I6 — a secret embedded in a key name, rather than a value, is emitted verbatim.

## Self-review (this round)

- Did not accept the reviewer's diagnosis of *where* the crash originated at face value even though
  the *what* (a Symbol/hostile-`toString` message crashes something) was correct — rebuilt, read the
  actual stack trace of the still-escaping exception with the narrower guard in place, and located
  the true origin (my own destructuring, not `stdSerializers.err` itself) before writing the fix.
  This matches the standing instruction throughout this task to verify empirically rather than
  reason from a plausible-sounding mechanism.
- Checked that the existing round-7 non-string-message test wasn't accidentally redundant with, or
  contradicted by, the four new ones — it isn't; it exercises a different code path, which is why it
  didn't already catch this.
- Confirmed the widened try/catch doesn't swallow legitimate output for the `{ err }, 'context msg'`
  shape — the explicit message survives unredacted in that pair of tests, proving the fallback is
  scoped to the error conversion, not the whole log call.
- `lint`/`typecheck` clean, no new `any`, no `console.log`, no `process.env` access.

## Concerns

1. C3 is now fixed at the level of "the whole error-to-safe-object conversion fails closed," which
   is a more defensible boundary than "the one pino call I assumed was the risky part" — but I
   cannot rule out a *third* step within that same conversion throwing for some other hostile shape
   I haven't tried. The try/catch is now scoped to the entire function body specifically so that a
   third such shape would still be caught without needing a fourth round on this exact issue.
2. `URL` joins `Map`/`Set`/`Buffer` as a named, undefeated residual in item 1 — not fixed, not newly
   discovered as broken (pre-existing), just no longer described inaccurately.
