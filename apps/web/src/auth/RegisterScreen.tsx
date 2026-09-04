'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { registerRequestSchema, type RegisterRequest } from '@sentinel/contracts';
import { Alert, Button, Field, Input } from '@sentinel/ui';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { register as registerAccount } from '../api/auth-endpoints';
import { useApiClient } from '../api/provider';
import { AuthCard } from './AuthCard';
import { PasswordInput } from './PasswordField';
import { applyServerErrors, type FormFailure } from './server-errors';

/**
 * The controls this form renders, and therefore the paths a server field error
 * may land on. Anything else the API names comes back in the form-level region
 * instead of being dropped.
 */
const FIELDS = ['email', 'password'] as const;

/**
 * `/register`.
 *
 * The four states `architecture/frontend.md` §6 requires of this screen:
 * **empty** is the pristine form, **loading** is the disabled pending submit,
 * **error** is the form-level region plus per-field errors, and **success** is
 * the "check your email" panel below — deliberately **not** a redirect into the
 * product, because `POST /auth/register` answers
 * `{ status: 'VERIFICATION_REQUIRED' }` and issues no session. There is nothing
 * to redirect to yet.
 *
 * `name` is on `registerRequestSchema` and is optional there; this form does
 * not collect it. An empty text input would submit `""`, which the contract's
 * `.min(1)` refuses, and the alternative — massaging the value before
 * validation — would mean this app deciding what a valid name is. The contract
 * is the authority; a screen that collects a name belongs with the code that
 * has somewhere to put it.
 */
export function RegisterScreen(): ReactNode {
  const client = useApiClient();
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const [verificationSentTo, setVerificationSentTo] = useState<string | null>(null);

  const {
    register: field,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterRequest>({
    resolver: zodResolver(registerRequestSchema),
    defaultValues: { email: '', password: '' },
    // forms.md §1 rule 6 — validating on every keystroke from the start means
    // telling someone their email is invalid while they are still typing it.
    mode: 'onBlur',
    reValidateMode: 'onChange',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      await registerAccount(client, values);
      setVerificationSentTo(values.email);
    } catch (error) {
      // The form is NOT reset. forms.md §1 rule 2: the user's input is theirs.
      setFailure(applyServerErrors<RegisterRequest>(error, FIELDS, setError));
    }
  });

  if (verificationSentTo !== null) {
    return (
      <AuthCard
        title="Check your email"
        lead="Your account is created but not yet active."
        footer={<Link href="/login">Back to sign in</Link>}
      >
        <Alert variant="success">
          <span>
            We sent a verification link to <strong>{verificationSentTo}</strong>. Open it to
            activate your account. The link expires, so if it has been a while, request a new one
            from the sign-in page.
          </span>
        </Alert>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create your account"
      lead="Sentinel tests assets you own and have proved you own."
      failure={failure}
      footer={
        <span>
          Already have an account? <Link href="/login">Sign in</Link>
        </span>
      }
    >
      <form
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
        className="flex flex-col gap-4"
      >
        <Field label="Work email" error={errors.email?.message}>
          <Input type="email" autoComplete="email" autoFocus {...field('email')} />
        </Field>

        <Field
          label="Password"
          description="At least 12 characters. Length beats symbols — a passphrase is fine."
          error={errors.password?.message}
        >
          <PasswordInput autoComplete="new-password" {...field('password')} />
        </Field>

        <Button type="submit" pending={isSubmitting} className="w-full">
          {isSubmitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </AuthCard>
  );
}
