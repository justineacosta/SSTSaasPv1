import { Alert, Badge, Card } from '@sentinel/ui';
import type { ReactNode } from 'react';

const workflow = [
  {
    step: 'Register',
    detail: 'Declare the assets you own — domains, hosts, applications, APIs.',
  },
  {
    step: 'Prove',
    detail:
      'Verify ownership of each one. Not a checkbox: a DNS record, a file, or a header we go and read.',
  },
  {
    step: 'Scope',
    detail: 'Define what is in and out of bounds, and test the rules before a scanner sees them.',
  },
  {
    step: 'Test',
    detail:
      'Run automated engines and record manual testing against that scope, and only that scope.',
  },
  {
    step: 'Triage',
    detail: 'Work one queue. Severity is the loudest thing on the screen because it is the point.',
  },
  {
    step: 'Retest and report',
    detail: 'Prove a finding is fixed, then produce the document somebody else has to read.',
  },
] as const;

export default function MarketingPage(): ReactNode {
  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-4">
        <Badge variant="neutral">Phase 1 · Foundation</Badge>
        <h1 className="font-display text-[length:var(--text-display)] leading-[var(--leading-display)] text-[var(--color-text)]">
          Security testing for assets you own, and have proved you own.
        </h1>
        <p className="max-w-2xl text-[length:var(--text-subhead)] leading-[var(--leading-subhead)] text-[var(--color-text-muted)]">
          Sentinel is a multi-tenant platform for security testing, penetration-test management, and
          vulnerability management. Proof of ownership and scope enforcement are not features here.
          They are the control everything else is built on top of.
        </p>
      </section>

      {/* Alert takes no `title` prop — it is a plain container with a role, so
          the heading is markup rather than an HTML `title` attribute, which
          would have rendered as a tooltip and been read by nothing. */}
      <Alert variant="info">
        <span>
          <strong className="font-medium">Nothing on this site is a product demo yet.</strong> This
          page is the first thing in Sentinel a browser has ever rendered. There is no
          authentication, no scanning, and no data. What is described below is the design
          commitment, not a shipped capability — see the roadmap in the repository for what actually
          runs today.
        </span>
      </Alert>

      <section className="flex flex-col gap-4">
        <h2 className="font-display text-[length:var(--text-title)] leading-[var(--leading-title)] text-[var(--color-text)]">
          The shape of the work
        </h2>
        <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {workflow.map(({ step, detail }, index) => (
            <li key={step}>
              {/* Card ships border, radius and surface only — no padding — so
                  a card wrapping a table can sit flush. Padding is the
                  caller's. */}
              <Card className="h-full p-4">
                <div className="flex flex-col gap-2">
                  <span className="text-[length:var(--text-micro)] leading-[var(--leading-micro)] tracking-[0.06em] text-[var(--color-text-subtle)] uppercase">
                    {/* Mono, because it is a count. design-system.md §2. */}
                    <span className="font-mono">{String(index + 1).padStart(2, '0')}</span> {step}
                  </span>
                  <p className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text-muted)]">
                    {detail}
                  </p>
                </div>
              </Card>
            </li>
          ))}
        </ol>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-[length:var(--text-title)] leading-[var(--leading-title)] text-[var(--color-text)]">
          Why the interface is this quiet
        </h2>
        <p className="max-w-2xl text-[length:var(--text-body)] leading-[var(--leading-body)] text-[var(--color-text-muted)]">
          In a findings table the single most important signal is severity, and severity is
          communicated by colour. If the chrome around it is also saturated, severity stops meaning
          anything. So the colour budget is spent in exactly one place, and everything else is
          near-neutral ink. It is an instrument, not a war room.
        </p>
      </section>
    </div>
  );
}
