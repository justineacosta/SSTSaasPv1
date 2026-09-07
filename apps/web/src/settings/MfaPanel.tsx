'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  mfaConfirmRequestSchema,
  mfaDisableRequestSchema,
  mfaEnrollRequestSchema,
  mfaRegenerateRecoveryCodesRequestSchema,
  type MfaConfirmRequest,
  type MfaDisableRequest,
  type MfaEnrollRequest,
  type MfaRegenerateRecoveryCodesRequest,
} from '@sentinel/contracts';
import { Alert, Button, Card, Field, Input } from '@sentinel/ui';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { confirmMfa, disableMfa, enrollMfa, regenerateRecoveryCodes } from '../api/auth-endpoints';
import { useApiClient } from '../api/provider';
import { FormErrorRegion } from '../auth/AuthCard';
import { PasswordInput } from '../auth/PasswordField';
import { applyServerErrors, type FormFailure } from '../auth/server-errors';
import { QrCode } from './QrCode';
import { RecoveryCodes } from './RecoveryCodes';

const PASSWORD_FIELDS = ['password'] as const;
const CODE_FIELDS = ['code'] as const;

/**
 * WHAT THIS SCREEN CAN AND CANNOT KNOW ABOUT THE ACCOUNT'S MFA STATE.
 *
 * `GET /auth/session` does **not** report whether a factor is enrolled.
 * `sessionResponseSchema` carries `userId`, `activeOrganization`, `permissions`
 * and `entitlements`, and no route in the published surface answers "is MFA on"
 * — checked against `apps/api/openapi.json` on 2026-09-07. So this panel offers
 * all three operations and lets the API be the authority on which of them are
 * valid right now: enrolling when a confirmed factor exists is 409
 * `DUPLICATE_RESOURCE`, and disabling or regenerating with MFA off is 422
 * `INVALID_STATE_TRANSITION` (`api/authentication.md` §2). Those refusals are
 * rendered where the user can read them.
 *
 * That is a real usability cost, and it is recorded here rather than papered
 * over: a panel that said "two-factor authentication is on" would be inventing
 * a fact no endpoint has told it.
 */
type Stage =
  | { kind: 'idle' }
  | { kind: 'enrolling'; secret: string; otpauthUri: string }
  | { kind: 'codes'; codes: readonly string[] };

export function MfaPanel(): ReactNode {
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });

  return (
    <Card className="flex flex-col gap-6 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-[length:var(--text-heading)] leading-[var(--leading-heading)] text-[var(--color-text)]">
          Two-factor authentication
        </h2>
        <p className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text-muted)]">
          A time-based code from an authenticator app, plus ten single-use recovery codes.
        </p>
      </div>

      {stage.kind === 'codes' ? (
        <RecoveryCodes
          codes={stage.codes}
          onDone={() => {
            setStage({ kind: 'idle' });
          }}
        />
      ) : null}

      {stage.kind === 'enrolling' ? (
        <ConfirmEnrolment
          secret={stage.secret}
          otpauthUri={stage.otpauthUri}
          onConfirmed={(codes) => {
            setStage({ kind: 'codes', codes });
          }}
          onCancel={() => {
            setStage({ kind: 'idle' });
          }}
        />
      ) : null}

      {stage.kind === 'idle' ? (
        <>
          <StartEnrolment
            onEnrolled={(secret, otpauthUri) => {
              setStage({ kind: 'enrolling', secret, otpauthUri });
            }}
          />
          <RegenerateCodes
            onRegenerated={(codes) => {
              setStage({ kind: 'codes', codes });
            }}
          />
          <DisableMfa />
          <p className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text-muted)]">
            Turning two-factor authentication on, off, or reissuing your recovery codes each require
            your current password. Confirming an enrolment does not — it is reachable only inside
            the window the enrolment opened.
          </p>
        </>
      ) : null}
    </Card>
  );
}

function StartEnrolment({
  onEnrolled,
}: {
  onEnrolled: (secret: string, otpauthUri: string) => void;
}): ReactNode {
  const client = useApiClient();
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const {
    register: field,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<MfaEnrollRequest>({
    resolver: zodResolver(mfaEnrollRequestSchema),
    defaultValues: { password: '' },
    mode: 'onBlur',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      const enrolled = await enrollMfa(client, values);
      reset({ password: '' });
      onEnrolled(enrolled.secret, enrolled.otpauthUri);
    } catch (error) {
      setFailure(applyServerErrors<MfaEnrollRequest>(error, PASSWORD_FIELDS, setError));
    }
  });

  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      aria-label="Set up an authenticator"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <h3 className="text-[length:var(--text-subhead)] leading-[var(--leading-subhead)] font-medium text-[var(--color-text)]">
        Set up an authenticator
      </h3>
      {failure === null ? null : <FormErrorRegion failure={failure} />}
      <Field label="Current password" error={errors.password?.message}>
        <PasswordInput autoComplete="current-password" {...field('password')} />
      </Field>
      <div>
        <Button type="submit" pending={isSubmitting}>
          Begin enrolment
        </Button>
      </div>
    </form>
  );
}

function ConfirmEnrolment({
  secret,
  otpauthUri,
  onConfirmed,
  onCancel,
}: {
  secret: string;
  otpauthUri: string;
  onConfirmed: (codes: readonly string[]) => void;
  onCancel: () => void;
}): ReactNode {
  const client = useApiClient();
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const {
    register: field,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<MfaConfirmRequest>({
    resolver: zodResolver(mfaConfirmRequestSchema),
    defaultValues: { code: '' },
    mode: 'onBlur',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      const confirmed = await confirmMfa(client, values);
      onConfirmed(confirmed.recoveryCodes);
    } catch (error) {
      setFailure(applyServerErrors<MfaConfirmRequest>(error, CODE_FIELDS, setError));
    }
  });

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-[length:var(--text-subhead)] leading-[var(--leading-subhead)] font-medium text-[var(--color-text)]">
        Scan this with your authenticator
      </h3>

      <div className="flex flex-wrap items-start gap-4">
        <QrCode value={otpauthUri} />
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text-muted)]">
            If you cannot scan it, enter this key by hand:
          </p>
          <code
            data-testid="mfa-secret"
            className="font-mono text-[length:var(--text-body)] leading-[var(--leading-body)] break-all text-[var(--color-text)]"
          >
            {secret}
          </code>
          <p className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text-muted)]">
            This key is shown once and nothing can read it back. If you lose it before confirming,
            start the enrolment again.
          </p>
        </div>
      </div>

      <form
        noValidate
        className="flex flex-col gap-3"
        aria-label="Confirm enrolment"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {failure === null ? null : <FormErrorRegion failure={failure} />}
        <Field
          label="Code from your authenticator"
          error={errors.code?.message}
          description="Six digits. A code is accepted once, so if you just used one, wait for the next."
        >
          <Input inputMode="numeric" autoComplete="one-time-code" {...field('code')} />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" pending={isSubmitting}>
            Confirm
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

function RegenerateCodes({
  onRegenerated,
}: {
  onRegenerated: (codes: readonly string[]) => void;
}): ReactNode {
  const client = useApiClient();
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const {
    register: field,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<MfaRegenerateRecoveryCodesRequest>({
    resolver: zodResolver(mfaRegenerateRecoveryCodesRequestSchema),
    defaultValues: { password: '' },
    mode: 'onBlur',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      const issued = await regenerateRecoveryCodes(client, values);
      reset({ password: '' });
      onRegenerated(issued.recoveryCodes);
    } catch (error) {
      setFailure(
        applyServerErrors<MfaRegenerateRecoveryCodesRequest>(error, PASSWORD_FIELDS, setError),
      );
    }
  });

  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      aria-label="Reissue recovery codes"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <h3 className="text-[length:var(--text-subhead)] leading-[var(--leading-subhead)] font-medium text-[var(--color-text)]">
        Reissue recovery codes
      </h3>
      <p className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text-muted)]">
        This replaces the whole set. Codes you saved before will stop working.
      </p>
      {failure === null ? null : <FormErrorRegion failure={failure} />}
      <Field label="Current password" error={errors.password?.message}>
        <PasswordInput autoComplete="current-password" {...field('password')} />
      </Field>
      <div>
        <Button type="submit" variant="secondary" pending={isSubmitting}>
          Reissue codes
        </Button>
      </div>
    </form>
  );
}

function DisableMfa(): ReactNode {
  const client = useApiClient();
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const {
    register: field,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<MfaDisableRequest>({
    resolver: zodResolver(mfaDisableRequestSchema),
    defaultValues: { password: '' },
    mode: 'onBlur',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      await disableMfa(client, values);
      reset({ password: '' });
      setConfirming(false);
      setDone(true);
    } catch (error) {
      setFailure(applyServerErrors<MfaDisableRequest>(error, PASSWORD_FIELDS, setError));
    }
  });

  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      aria-label="Turn two-factor authentication off"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <h3 className="text-[length:var(--text-subhead)] leading-[var(--leading-subhead)] font-medium text-[var(--color-text)]">
        Turn two-factor authentication off
      </h3>
      <Alert variant="warning">
        <span>
          This deletes your authenticator and every recovery code. Your password becomes the only
          thing protecting this account.
        </span>
      </Alert>
      {failure === null ? null : <FormErrorRegion failure={failure} />}
      {done ? (
        <Alert variant="success">
          <span>Two-factor authentication is off.</span>
        </Alert>
      ) : null}
      <Field label="Current password" error={errors.password?.message}>
        <PasswordInput autoComplete="current-password" {...field('password')} />
      </Field>
      {/* A destructive, irreversible action gets a deliberate second step
          (architecture/frontend.md §4). The password is not that confirmation:
          the API demands it whether or not this screen asks twice. */}
      <div className="flex gap-2">
        {confirming ? (
          <>
            <Button type="submit" variant="danger" pending={isSubmitting}>
              Yes, turn it off
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setConfirming(true);
            }}
          >
            Turn it off
          </Button>
        )}
      </div>
    </form>
  );
}
