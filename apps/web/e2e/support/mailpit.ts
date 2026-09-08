import { expect } from '@playwright/test';
import { E2E_MAILPIT_ORIGIN, E2E_WEB_ORIGIN } from '../../playwright.config';

/**
 * Reading real email out of Mailpit, because the journey criterion says to.
 *
 * The plan's Task 18 checklist spells it out: "receive the verification email
 * (read it from **Mailpit's API**, not a stubbed link)". The distinction is the
 * whole point of the step. A stubbed link tests that the token the test itself
 * generated round-trips; reading the inbox tests the thing that actually broke
 * in this phase — `TOKEN_LINK_PATHS` naming a path no screen served, which no
 * unit test could see because no test in this repository followed a link out of
 * an inbox (ruling 143).
 *
 * Mailpit is shared with ordinary development and is never emptied by this
 * suite, so nothing here may assume an empty mailbox or "the newest message".
 * Every lookup is by recipient, and every spec addresses a unique recipient per
 * run.
 */

/** The subset of Mailpit's message summary this suite reads. */
interface MailpitSummary {
  readonly ID: string;
  readonly Subject: string;
}

interface MailpitSearchResponse {
  readonly messages: readonly MailpitSummary[];
}

interface MailpitMessage {
  readonly Text: string;
  readonly HTML: string;
}

async function mailpitJson<T>(path: string): Promise<T> {
  const response = await fetch(`${E2E_MAILPIT_ORIGIN}${path}`);
  if (!response.ok) {
    throw new Error(
      `Mailpit answered ${String(response.status)} for ${path}. Is the Compose stack up?`,
    );
  }
  return (await response.json()) as T;
}

/**
 * Waits for a message addressed to `recipient` and returns its body.
 *
 * Polled rather than awaited on a signal, because mail delivery is genuinely
 * asynchronous here: the API answers the HTTP request and hands the message to
 * nodemailer, which reaches Mailpit over SMTP some milliseconds later. A test
 * that read the inbox immediately after the response would be racing that, and
 * the flake would look like "the product does not send mail".
 *
 * `expect.poll` rather than a hand-rolled loop so a timeout is reported as a
 * Playwright assertion with the recipient in the message, instead of as a bare
 * rejection.
 */
async function findMessageId(recipient: string, subjectContains: string): Promise<string | null> {
  // `to:` rather than a full-text query: an address appearing in a *different*
  // message's body would otherwise match, and the invitation journey has two
  // addresses in play at once.
  const query = encodeURIComponent(`to:${recipient}`);
  const { messages } = await mailpitJson<MailpitSearchResponse>(`/api/v1/search?query=${query}`);
  return messages.find((message) => message.Subject.includes(subjectContains))?.ID ?? null;
}

export async function waitForEmail(recipient: string, subjectContains: string): Promise<string> {
  await expect
    .poll(async () => (await findMessageId(recipient, subjectContains)) !== null, {
      message: `No message to ${recipient} with a subject containing ${JSON.stringify(subjectContains)} arrived in Mailpit.`,
      timeout: 20_000,
    })
    .toBe(true);

  // Looked up a second time rather than captured from inside the poll. A `let`
  // assigned only in the poll's closure is narrowed by the compiler to the type
  // of its initialiser, so the null check below would leave `never` and the
  // template literal after it would stop compiling. One extra request against a
  // local container is cheaper than a non-null assertion or a cast, and it is
  // the request the poll has just proven will succeed.
  const messageId = await findMessageId(recipient, subjectContains);
  if (messageId === null) throw new Error('unreachable: poll succeeded without a message id');

  const message = await mailpitJson<MailpitMessage>(`/api/v1/message/${messageId}`);
  return `${message.Text}\n${message.HTML}`;
}

/**
 * The first link in `body` whose path is `path`, returned as a path + query
 * string ready to hand to `page.goto`.
 *
 * **It asserts the link's origin is the suite's own web server**, which is not
 * incidental tidiness. The origin comes from `WEB_BASE_URL`, read once at API
 * boot, and getting it wrong is exactly the failure this harness exists to
 * prevent — a link into a developer's server on another port would 404, or
 * worse, succeed against an application the suite is not testing.
 */
export function linkFromEmail(body: string, path: string): string {
  const pattern = new RegExp(`https?://[^\\s"'<>]*${path}\\?[^\\s"'<>]*`, 'u');
  const found = pattern.exec(body);
  if (found === null) {
    throw new Error(`No ${path} link in the email body.`);
  }

  const url = new URL(found[0]);
  expect(
    url.origin,
    `The emailed link points at ${url.origin}, not at the suite's own web server. ` +
      `WEB_BASE_URL is read once at API boot — see apps/api/scripts/start-e2e.ts.`,
  ).toBe(E2E_WEB_ORIGIN);

  return `${url.pathname}${url.search}`;
}
