'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { changePasswordRequestSchema, type ChangePasswordRequest } from '@sentinel/contracts';
import { Alert, Button, Card, Field } from '@sentinel/ui';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { changePassword } from '../api/auth-endpoints';
import { useApiClient } from '../api/provider';
import { FormErrorRegion } from '../auth/AuthCard';
import { PasswordInput } from '../auth/PasswordField';
import { applyServerErrors, type FormFailure } from '../auth/server-errors';

const FIELDS = ['currentPassword', 'newPassword'] as const;

/**
 * `POST /api/v1/auth/change-password`.
 *
 * The current password is required, and the screen says why rather than
 * treating it as a form of friction: `api/authentication.md` §2 —
 * "Changing a password from a stolen session without proving the old one is an
 * account-takeover step, not a settings edit."
 *
 * **The form is not cleared on failure** (`architecture/frontend.md` §4), which
 * `applyServerErrors` and the absence of a `reset()` in the catch arm together
 * guarantee. On success it is cleared, deliberately: two password values left
 * in the DOM after they are no longer needed is not something to keep.
 *
 * The API rotates the caller's session and replaces both cookies, so nothing
 * here signs the user out or navigates. Every other session is revoked by the
 * API, which is what the success message says.
 */
export function PasswordPanel(): ReactNode {
  const client = useApiClient();
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const [done, setDone] = useState(false);

  const {
    register: field,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordRequest>({
    resolver: zodResolver(changePasswordRequestSchema),
    defaultValues: { currentPassword: '', newPassword: '' },
    mode: 'onBlur',
    reValidateMode: 'onChange',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    setDone(false);
    try {
      await changePassword(client, values);
      reset({ currentPassword: '', newPassword: '' });
      setDone(true);
    } catch (error) {
      setFailure(applyServerErrors<ChangePasswordRequest>(error, FIELDS, setError));
    }
  });

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-[length:var(--text-heading)] leading-[var(--leading-heading)] text-[var(--color-text)]">
          Password
        </h2>
        <p className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text-muted)]">
          At least 12 characters. Length beats symbols — a passphrase is fine. Your current password
          is required: changing it from a stolen session without proving the old one is an
          account-takeover step, not a settings edit.
        </p>
      </div>

      {done ? (
        <Alert variant="success">
          <span>
            Your password is changed and every other device has been signed out. This one stays
            signed in.
          </span>
        </Alert>
      ) : null}

      <form
        noValidate
        aria-label="Change password"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {failure === null ? null : <FormErrorRegion failure={failure} />}

        <Field label="Current password" error={errors.currentPassword?.message}>
          <PasswordInput autoComplete="current-password" {...field('currentPassword')} />
        </Field>

        <Field label="New password" error={errors.newPassword?.message}>
          <PasswordInput autoComplete="new-password" {...field('newPassword')} />
        </Field>

        <div>
          <Button type="submit" pending={isSubmitting}>
            {isSubmitting ? 'Saving…' : 'Change password'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
