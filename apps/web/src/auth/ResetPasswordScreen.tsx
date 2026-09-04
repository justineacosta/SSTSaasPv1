'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { resetPasswordRequestSchema, type ResetPasswordRequest } from '@sentinel/contracts';
import { Alert, Button, Field } from '@sentinel/ui';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { resetPassword } from '../api/auth-endpoints';
import { useApiClient } from '../api/provider';
import { AuthCard } from './AuthCard';
import { PasswordInput } from './PasswordField';
import { applyServerErrors, type FormFailure } from './server-errors';

const FIELDS = ['password'] as const;

/**
 * `/reset-password`.
 *
 * The token arrives in the query string, and that is the existing design of the
 * endpoint rather than something to fix here: it comes from a link in an email
 * and there is nowhere else for it to be. Contrast `/login/mfa`'s
 * `pendingToken`, which this app generates and therefore keeps out of the URL.
 *
 * **Empty state:** a link with no token at all. It is a real state — a mail
 * client that truncated the URL produces it — so it says what happened and
 * offers the way to get a fresh link, rather than rendering a form that can
 * only fail.
 */
export function ResetPasswordScreen({ token }: { token: string | null }): ReactNode {
  const client = useApiClient();
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const [done, setDone] = useState(false);

  const {
    register: field,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordRequest>({
    resolver: zodResolver(resetPasswordRequestSchema),
    defaultValues: { token: token ?? '', password: '' },
    mode: 'onBlur',
    reValidateMode: 'onChange',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      await resetPassword(client, values);
      setDone(true);
    } catch (error) {
      setFailure(applyServerErrors<ResetPasswordRequest>(error, FIELDS, setError));
    }
  });

  if (token === null || token === '') {
    return (
      <AuthCard
        title="This link is incomplete"
        footer={<Link href="/forgot-password">Request a new link</Link>}
      >
        <Alert variant="warning">
          <span>
            The reset link did not carry a token. Some mail clients shorten long links — copy the
            whole URL from the email, or request a new one.
          </span>
        </Alert>
      </AuthCard>
    );
  }

  if (done) {
    return (
      <AuthCard title="Password changed" footer={<Link href="/login">Go to sign in</Link>}>
        <Alert variant="success">
          <span>
            Your password is updated and every other session on the account has been signed out.
            Sign in with the new password.
          </span>
        </Alert>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Choose a new password"
      lead="At least 12 characters. Length beats symbols — a passphrase is fine."
      failure={failure}
      footer={<Link href="/login">Back to sign in</Link>}
    >
      <form
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
        className="flex flex-col gap-4"
      >
        {/* Carried in the form's values so one contract schema validates the
            whole request body. Never rendered as text. */}
        <input type="hidden" {...field('token')} />

        <Field label="New password" error={errors.password?.message}>
          <PasswordInput autoComplete="new-password" autoFocus {...field('password')} />
        </Field>

        <Button type="submit" pending={isSubmitting} className="w-full">
          {isSubmitting ? 'Saving…' : 'Set new password'}
        </Button>
      </form>
    </AuthCard>
  );
}
