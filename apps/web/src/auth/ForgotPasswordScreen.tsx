'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { forgotPasswordRequestSchema, type ForgotPasswordRequest } from '@sentinel/contracts';
import { Alert, Button, Field, Input } from '@sentinel/ui';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { forgotPassword } from '../api/auth-endpoints';
import { useApiClient } from '../api/provider';
import { AuthCard } from './AuthCard';
import { applyServerErrors, type FormFailure } from './server-errors';

const FIELDS = ['email'] as const;

/**
 * `/forgot-password`.
 *
 * **THE SUCCESS STATE MUST NOT REVEAL WHETHER THE ADDRESS EXISTS.**
 *
 * That is the endpoint's entire design — `forgotPasswordResponseSchema` is a
 * single constant literal, `RESET_REQUESTED`, precisely so that a constant
 * response cannot leak which addresses are registered — and a screen is the
 * easiest place in the system to undo it. "We couldn't find that account" or a
 * different message on the two paths would hand an attacker a working account
 * enumerator built out of a helpful error message.
 *
 * So the copy below is deliberately conditional on nothing. It says what was
 * done ("if that address has an account") rather than what was found, and it is
 * identical for every address anyone ever types.
 */
export function ForgotPasswordScreen(): ReactNode {
  const client = useApiClient();
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const [requested, setRequested] = useState(false);

  const {
    register: field,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordRequest>({
    resolver: zodResolver(forgotPasswordRequestSchema),
    defaultValues: { email: '' },
    mode: 'onBlur',
    reValidateMode: 'onChange',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      await forgotPassword(client, values);
      setRequested(true);
    } catch (error) {
      setFailure(applyServerErrors<ForgotPasswordRequest>(error, FIELDS, setError));
    }
  });

  if (requested) {
    return (
      <AuthCard title="Check your email" footer={<Link href="/login">Back to sign in</Link>}>
        <Alert variant="success">
          <span>
            If that address has a Sentinel account, a reset link is on its way. The link expires,
            and using it signs out every other session on the account.
          </span>
        </Alert>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Reset your password"
      lead="Enter the address you signed up with and we will email you a link."
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
        <Field label="Work email" error={errors.email?.message}>
          <Input type="email" autoComplete="username" autoFocus {...field('email')} />
        </Field>

        <Button type="submit" pending={isSubmitting} className="w-full">
          {isSubmitting ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
    </AuthCard>
  );
}
