'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  resendVerificationRequestSchema,
  type ResendVerificationRequest,
} from '@sentinel/contracts';
import { Alert, Button, Field, Input, Skeleton } from '@sentinel/ui';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { resendVerification, verifyEmail } from '../api/auth-endpoints';
import { useApiClient } from '../api/provider';
import { AuthCard, FormErrorRegion } from './AuthCard';
import { applyServerErrors, toFormFailure, type FormFailure } from './server-errors';

const RESEND_FIELDS = ['email'] as const;

type VerificationStatus = 'no-token' | 'verifying' | 'verified' | 'failed';

/**
 * `/verify-email`.
 *
 * The one screen here that submits **on load** rather than on a click, which is
 * what gives it a genuine loading state and a genuine failure state instead of
 * the degenerate ones a plain form has.
 *
 * The token arrives in the query string because it arrives from a link in an
 * email and there is nowhere else for it to be — the same reasoning as
 * `/reset-password`, and the opposite of `/login/mfa`'s `pendingToken`, which
 * this app generates and therefore never puts in a URL.
 *
 * **Why the request is fired from a ref-guarded effect and never aborted on
 * cleanup.** `reactStrictMode` is on (`next.config.ts`), so in development React
 * mounts, unmounts and remounts every component once, running each effect
 * twice. A verification token is single-use: the second call would consume
 * nothing and answer `TOKEN_INVALID`, and the screen would show a failure for a
 * verification that actually succeeded. The ref records the token already
 * attempted, so the second run is a no-op. Aborting in a cleanup would be the
 * usual answer and is wrong here — the cleanup from the first mount fires
 * *before* the second run, so it would cancel the only request that was ever
 * going to be made.
 */
export function VerifyEmailScreen({ token }: { token: string | null }): ReactNode {
  const client = useApiClient();
  const [status, setStatus] = useState<VerificationStatus>(
    token === null || token === '' ? 'no-token' : 'verifying',
  );
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const attemptedToken = useRef<string | null>(null);

  useEffect(() => {
    if (token === null || token === '') return;
    if (attemptedToken.current === token) return;
    attemptedToken.current = token;

    void (async () => {
      try {
        await verifyEmail(client, { token });
        setStatus('verified');
      } catch (error) {
        setFailure(toFormFailure(error));
        setStatus('failed');
      }
    })();
  }, [client, token]);

  if (status === 'verifying') {
    return (
      <AuthCard title="Verifying your email" lead="This takes a moment.">
        {/* A skeleton matching the final layout rather than a spinner, and no
            layout shift when the answer arrives. frontend.md §6. */}
        <div aria-busy="true" aria-live="polite" className="flex flex-col gap-3">
          <span className="sr-only">Verifying your email address.</span>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-2/3" />
        </div>
      </AuthCard>
    );
  }

  if (status === 'verified') {
    return (
      <AuthCard title="Email verified" footer={<Link href="/login">Go to sign in</Link>}>
        <Alert variant="success">
          <span>Your address is confirmed. You can sign in now.</span>
        </Alert>
      </AuthCard>
    );
  }

  const heading =
    status === 'no-token' ? 'This link is incomplete' : 'We could not verify that link';

  return (
    <AuthCard
      title={heading}
      lead={
        status === 'no-token'
          ? 'The verification link did not carry a token. Some mail clients shorten long links.'
          : 'Verification links are single-use and they expire. Enter your address and we will send a new one.'
      }
      footer={<Link href="/login">Back to sign in</Link>}
    >
      <div className="flex flex-col gap-4">
        {failure === null ? null : <FormErrorRegion failure={failure} />}
        <ResendVerificationForm />
      </div>
    </AuthCard>
  );
}

/**
 * The resend affordance, on both failure paths.
 *
 * Its success message is deliberately constant and says nothing about whether
 * the address is registered: `resendVerificationResponseSchema` is the same
 * single literal `forgotPasswordResponseSchema` is, for the same
 * enumeration-resistance reason, and a helpful "no such account" here would
 * undo it.
 */
function ResendVerificationForm(): ReactNode {
  const client = useApiClient();
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<FormFailure | null>(null);

  const {
    register: field,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ResendVerificationRequest>({
    resolver: zodResolver(resendVerificationRequestSchema),
    defaultValues: { email: '' },
    mode: 'onBlur',
    reValidateMode: 'onChange',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      await resendVerification(client, values);
      setSent(true);
    } catch (error) {
      setFailure(applyServerErrors<ResendVerificationRequest>(error, RESEND_FIELDS, setError));
    }
  });

  if (sent) {
    return (
      <Alert variant="success">
        <span>
          If that address needs verifying, a new link is on its way. Check your spam folder before
          asking again.
        </span>
      </Alert>
    );
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
      className="flex flex-col gap-4"
    >
      {failure === null ? null : <FormErrorRegion failure={failure} />}
      <Field label="Work email" error={errors.email?.message}>
        <Input type="email" autoComplete="username" {...field('email')} />
      </Field>
      <Button type="submit" pending={isSubmitting} className="w-full">
        {isSubmitting ? 'Sending…' : 'Send a new link'}
      </Button>
    </form>
  );
}
