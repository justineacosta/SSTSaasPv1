'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { mfaVerifyRequestSchema, type MfaVerifyRequest } from '@sentinel/contracts';
import { Alert, Button, Field, Input } from '@sentinel/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { verifyMfa } from '../api/auth-endpoints';
import { useApiClient } from '../api/provider';
import { AuthCard } from './AuthCard';
import { useMfaChallenge } from './MfaChallengeProvider';
import { applyServerErrors, type FormFailure } from './server-errors';

const FIELDS = ['code'] as const;

/**
 * ONE SCREEN, TWO KINDS OF CODE.
 *
 * `.claude/ui-ux/page-map.md` lists `/mfa` and a separate `/recovery`. There is
 * only one endpoint behind them: `POST /auth/mfa/verify`'s own OpenAPI
 * description says `code` "accepts a six-digit code from the authenticator app
 * OR one of the ten recovery codes"
 * (`apps/api/src/modules/auth/auth.controller.ts`), and the contract's
 * `mfaCodeSchema` is deliberately not narrowed to six digits for exactly that
 * reason. Two routes over one endpoint would be two screens to keep in step for
 * no gain, so this is one screen with a mode switch.
 *
 * The mode is not cosmetic. A TOTP code is six digits and belongs to the
 * platform's one-time-code autofill; a recovery code is neither numeric nor
 * something a phone will ever offer to fill. `inputMode`, `autoComplete`,
 * `maxLength` and the label therefore all move together — a numeric keypad in
 * front of an alphanumeric recovery code is a user who cannot type their way
 * out of a lost phone.
 */
type CodeMode = 'totp' | 'recovery';

export function MfaScreen(): ReactNode {
  const client = useApiClient();
  const router = useRouter();
  const { challenge, clearChallenge } = useMfaChallenge();
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const [mode, setMode] = useState<CodeMode>('totp');

  const {
    register: field,
    handleSubmit,
    setError,
    resetField,
    formState: { errors, isSubmitting },
  } = useForm<MfaVerifyRequest>({
    resolver: zodResolver(mfaVerifyRequestSchema),
    defaultValues: { pendingToken: challenge?.pendingToken ?? '', code: '' },
    mode: 'onBlur',
    reValidateMode: 'onChange',
  });

  // The empty state, and a real one rather than a defensive branch. The pending
  // credential lives in memory only (MfaChallengeProvider), so a reload or a
  // direct visit arrives here with nothing to verify. Saying so and offering the
  // way back beats a form that can only fail.
  if (challenge === null) {
    return (
      <AuthCard title="Start again" footer={<Link href="/login">Back to sign in</Link>}>
        <Alert variant="warning">
          <span>
            This sign-in attempt is no longer in progress. For your security the pending
            credential is held in memory only, so reloading this page or opening it directly ends
            it. Sign in again to get a new challenge.
          </span>
        </Alert>
      </AuthCard>
    );
  }

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      await verifyMfa(client, values);
      clearChallenge();
      router.replace(challenge.redirectTo);
    } catch (error) {
      setFailure(applyServerErrors<MfaVerifyRequest>(error, FIELDS, setError));
    }
  });

  const isTotp = mode === 'totp';

  return (
    <AuthCard
      title="Two-factor authentication"
      lead={
        isTotp
          ? 'Enter the six-digit code from your authenticator app.'
          : 'Enter one of the recovery codes you saved when you enrolled. Each one works once.'
      }
      failure={failure}
      footer={<Link href="/login">Cancel and sign in again</Link>}
    >
      <form
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
        className="flex flex-col gap-4"
      >
        {/* The pending credential rides in the form's values so one contract
            schema validates the whole request body, and in a hidden input so
            React Hook Form owns exactly one copy of it. It is never rendered as
            text and never reaches the URL. */}
        <input type="hidden" {...field('pendingToken')} />

        <Field
          label={isTotp ? 'Authentication code' : 'Recovery code'}
          error={errors.code?.message}
        >
          <Input
            key={mode}
            autoFocus
            inputMode={isTotp ? 'numeric' : 'text'}
            autoComplete={isTotp ? 'one-time-code' : 'off'}
            {...(isTotp ? { maxLength: 6, pattern: '[0-9]*' } : {})}
            spellCheck={false}
            autoCapitalize="off"
            {...field('code')}
          />
        </Field>

        <Button type="submit" pending={isSubmitting} className="w-full">
          {isSubmitting ? 'Verifying…' : 'Verify code'}
        </Button>

        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setMode(isTotp ? 'recovery' : 'totp');
            // The code already typed belongs to the other mode; keeping it
            // would submit a six-digit string as a recovery code.
            resetField('code');
            setFailure(null);
          }}
        >
          {isTotp ? 'Use a recovery code instead' : 'Use my authenticator app instead'}
        </Button>
      </form>
    </AuthCard>
  );
}
