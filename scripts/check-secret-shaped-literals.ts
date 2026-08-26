/**
 * `pnpm check:secrets` — no committed file carries a string that *looks* like a
 * credential, whether or not it is one.
 *
 * THE TRAP THIS EXISTS FOR. Four of this repository's code pull requests have
 * failed a secret scanner, and not one of them contained a real credential:
 *
 * | PR  | What the scanner flagged                        | Where                          |
 * |-----|-------------------------------------------------|--------------------------------|
 * | #5  | Bearer Token, High Entropy, Username Password   | `phase-1/review-diffs/*.diff`  |
 * | #6  | Generic Password                                | `auth.module.spec.ts`          |
 * | #8  | 4 x Generic High Entropy Secret                 | `redaction.spec.ts`            |
 * | #10 | 2 x Generic High Entropy Secret                 | two email spec fixtures        |
 *
 * Every one was a test fixture standing in for a secret, written to look
 * realistic — which is exactly what makes it indistinguishable from the real
 * thing to a scanner, to a reviewer, and to the next person to copy it. The
 * cost was never a breach. It was a security product's own security check being
 * red on three of its four code pull requests, which trains people to ignore
 * it, and two `git filter-branch` rewrites in Task 5 to undo values that were
 * never credentials.
 *
 * WHY NOT `.gitguardian.yaml`. `roadmap.md` recorded an ignore list as owed
 * from PR #5 until this check was written, and it would not have worked.
 * `ignored_matches` in `.gitguardian.yaml` is read by the **ggshield CLI**,
 * which this repository does not run. The failing check is the GitGuardian
 * **GitHub App**, which is driven from the dashboard — its findings are cleared
 * by a check-run skip action or by resolving the incident there, never by a
 * file in the repository. An ignore list would have been a control that looks
 * like a control and does nothing, which is worse than an absent one.
 *
 * WHAT THIS CHECKS INSTEAD. The cause, not the symptom: a fixture must not look
 * like a credential. It runs before a push rather than after one, it names the
 * file and line, and it is this repository's own rule rather than a third
 * party's opinion.
 *
 * IT WOULD HAVE CAUGHT THE LEDGER TOKEN TOO. Task 5 pasted a real 256-bit
 * token into a committed ledger file and paid a history rewrite for it. That
 * value is caught by the same rule as the fixtures, which is why `.md` is
 * scanned and not only `.ts`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It is not a secret scanner. It has no
 * provider signatures, it validates nothing against an API, and a low-entropy
 * real credential (`hunter2`) sails straight past. It is a shape rule, and its
 * whole claim is that a string with a credential's shape does not belong in a
 * committed file even when it is inert.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Shannon entropy in bits per character.
 *
 * The discriminator between a random 43-character token and a 43-character
 * sentence, and the same measure the "Generic High Entropy Secret" detectors
 * use. Measured on this repository's own history: the two Task 5 fixtures score
 * 4.9 and 4.8, the leaked ledger token 4.9, and their replacements — which keep
 * the length and charset but repeat characters — score 3.4.
 */
function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);

  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    bits -= probability * Math.log2(probability);
  }
  return bits;
}

/**
 * Runs of **alphanumeric** characters long enough to be a credential.
 *
 * 24 is the floor because a 128-bit secret is 22 base64 characters and a
 * 256-bit one is 43; below that the false-positive rate against ordinary
 * identifiers climbs fast and the value is too short to be worth stealing.
 *
 * `-` and `_` are deliberately treated as **separators rather than content**,
 * which is the single decision that makes this check usable. Including them
 * matched every hyphenated slug this repository is full of — measured, the
 * first run of this script reported **1464** findings, almost all of them
 * `ADR-0016-smtp-mailer-port` and its siblings, which clear the length floor
 * and score 3.9–4.3 on entropy. Splitting on the separators breaks a slug into
 * short words and leaves a token intact: a base64url secret rarely carries more
 * than one or two of them, so its longest alphanumeric run is still
 * credential-length. Both Task 5 fixtures and the leaked ledger token are still
 * caught this way — verified in this script's spec, which pins that exact
 * property.
 */
const CANDIDATE = /[A-Za-z0-9]{24,}/g;

/**
 * Entropy above which a candidate is treated as credential-shaped.
 *
 * Measured on this repository: real random tokens score 4.6–4.9, the tightest
 * surviving false positive scores below 4.2. Set at 4.2 rather than at the
 * midpoint because the cost of the two errors is not symmetric — a missed
 * fixture costs one red check, and a noisy check costs its own credibility.
 */
const ENTROPY_CEILING = 4.2;

/**
 * A candidate must mix all three character classes.
 *
 * This is what separates a token from prose and from this repository's own
 * long identifiers, and it was chosen by measurement rather than by taste:
 * `content-security-policy-report-only` and
 * `Finding_organizationId_fingerprint_key` both clear the length floor and one
 * of them clears the entropy ceiling, and neither carries a digit alongside
 * both cases. A 40-character git SHA is lowercase hex, so it has no uppercase
 * and is excluded by the same rule — which matters because the ledger quotes
 * commit hashes constantly and flagging those would make this check noise.
 *
 * The cost is stated plainly: an all-lowercase credential (a hex API key, a
 * lowercase UUID) is not caught. That is a real gap, and the alternative —
 * dropping the class requirement — flags every commit SHA in `docs/`, which
 * would get the check switched off within a week.
 */
function mixesCharacterClasses(value: string): boolean {
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value);
}

/**
 * Markers that say "this is deliberately not a credential".
 *
 * A fixture that announces itself is the outcome this check exists to produce,
 * so it must have a way to pass. This is an escape hatch and it is meant to be
 * one: anyone can defeat the check by naming a real secret `FIXTURE_`. That is
 * true of every lint rule in this repository and is not what any of them are
 * defending against — the failure mode here is carelessness, not an adversary
 * with commit access.
 */
const DELIBERATELY_FAKE = /FIXTURE|EXAMPLE|PLACEHOLDER|REDACTED|NOT_A_REAL|DO_NOT_USE/i;

/**
 * Frozen historical artefacts, excluded by path.
 *
 * `phase-1/review-diffs/` holds captured `git diff` output from Phase 1
 * reviews. They are a record of what was reviewed and are never edited, so a
 * finding in one cannot be fixed without falsifying the record — and PR #5's
 * three findings all live there. Excluding them is honest; pretending a check
 * covers them and then ignoring what it says would not be.
 */
const EXCLUDED_PATHS = [
  /^docs\/superpowers\/ledger\/phase-1\/review-diffs\//,
  // Lockfiles are generated, and every `resolution.integrity` value is a
  // base64 SHA-512 by construction. Measured: 1177 of this check's first 1226
  // findings were `pnpm-lock.yaml` and nothing else. They are not authored, not
  // credentials, and not fixable — scanning them would only teach a reader that
  // this check is noise.
  /^pnpm-lock\.yaml$/,
  /(^|\/)package-lock\.json$/,
];

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly value: string;
  readonly entropy: number;
}

function trackedFiles(): string[] {
  const output = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.md', '*.json', '*.yaml'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return output
    .split('\n')
    .filter((path) => path.length > 0)
    .filter((path) => !EXCLUDED_PATHS.some((pattern) => pattern.test(path)));
}

function scan(file: string): Finding[] {
  const findings: Finding[] = [];
  const lines = readFileSync(file, 'utf8').split('\n');

  lines.forEach((line, index) => {
    // The check's own source and spec describe the rule and necessarily
    // contain examples of what it matches. Skipping by marker rather than by
    // filename so the rule stays true of any file that opts out explicitly.
    if (DELIBERATELY_FAKE.test(line)) return;

    for (const match of line.matchAll(CANDIDATE)) {
      const value = match[0];
      if (!mixesCharacterClasses(value)) continue;

      const entropy = shannonEntropy(value);
      if (entropy < ENTROPY_CEILING) continue;

      findings.push({ file, line: index + 1, value, entropy });
    }
  });

  return findings;
}

const findings = trackedFiles().flatMap(scan);

if (findings.length > 0) {
  // eslint-disable-next-line no-console
  console.error(
    `check:secrets FAILED — ${String(findings.length)} credential-shaped literal(s) in committed files.\n`,
  );

  for (const finding of findings) {
    // The value is truncated deliberately. If one of these ever IS a real
    // credential, this output lands in CI logs, and printing it in full would
    // be the thing the check exists to prevent.
    const preview = `${finding.value.slice(0, 6)}…${finding.value.slice(-4)}`;
    // eslint-disable-next-line no-console
    console.error(
      `  ${finding.file}:${String(finding.line)} — ${String(finding.value.length)} chars, entropy ${finding.entropy.toFixed(2)} (${preview})`,
    );
  }

  // eslint-disable-next-line no-console
  console.error(
    [
      '',
      'A string with a credential’s shape does not belong in a committed file,',
      'even when it is inert. Three of this repository’s four code pull requests',
      'failed a secret scanner on exactly this, and none held a real credential.',
      '',
      'If it is a fixture: keep the length and charset the test needs and drop the',
      'entropy — FIXTURE_not_a_real_token-0000000000 passes and still exercises',
      'base64url handling.',
      '',
      'If it is a real credential: it does not go in the repository at all, and',
      'redacting it in the working tree is not enough — a scanner reads every',
      'commit in a pull request, not the final tree. See ruling 63.',
    ].join('\n'),
  );

  process.exit(1);
}

// eslint-disable-next-line no-console
console.log(
  `check:secrets OK — ${String(trackedFiles().length)} tracked files, no credential-shaped literals.`,
);
