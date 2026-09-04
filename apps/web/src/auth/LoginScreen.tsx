'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { loginRequestSchema, type LoginRequest } from '@sentinel/contracts';
import { Button, Field, Input } from '@sentinel/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { login } from '../api/auth-endpoints';
import { useApiClient } from '../api/provider';
import { safeRedirectPath } from '../api/redirect';
import { AuthCard } from './AuthCard';
import { useMfaChallenge } from './MfaChallengeProvider';
import { PasswordInput } from './PasswordField';
import { applyServerErrors, type FormFailure } from './server-errors';

const FIELDS = ['email', 'password'] as const;

/**
 * `/login`.
 *
 * Two things here are worth more than the markup around them.
 *
 * **The `mfaRequired` branch.** `loginResponseSchema` is a discriminated union,
 * so `pendingToken` is unreachable without narrowing on the discriminant —
 * which is exactly why the contract is a union rather than one object with an
 * optional token. The failure mode that shape rules out is a client that
 * forgets to check `mfaRequired` and treats a half-authenticated login as
 * complete.
 *
 * **`redirectTo` is attacker-controlled.** It arrives from the query string, so
 * it goes through `safeRedirectPath` before it reaches the router. Every
 * rejection case is tested in `src/api/redirect.spec.ts`; an open redirect on a
 * login page is a real finding and this is the one place on these screens where
 * client-side validation is load-bearing rather than a convenience.
 */
export function LoginScreen({ redirectTo }: { redirectTo: string | null }): ReactNode {
  const client = useApiClient();
  const router = useRouter();
  const { startChallenge } = useMfaChallenge();
  const [failure, setFailure] = useState<FormFailure | null>(null);

  const {
    register: field,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
    defaultValues: { email: '', password: '', rememberMe: false },
    mode: 'onBlur',
    reValidateMode: 'onChange',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    // Validated once, here, so both branches below navigate to a checked path
    // and neither can be handed the raw parameter by a later edit.
    const destination = safeRedirectPath(redirectTo);
    try {
      const result = await login(client, values);
      if (result.mfaRequired) {
        // The token goes into memory and into the next screen's props — never
        // into the URL. See MfaChallengeProvider's docblock for why.
        startChallenge({ pendingToken: result.pendingToken, redirectTo: destination });
        router.push('/login/mfa');
        return;
      }
      // `replace`, not `push`: the sign-in page has served its purpose, and
      // leaving it in history means Back lands on a form for a session that
      // already exists.
      router.replace(destination);
    } catch (error) {
      setFailure(applyServerErrors<LoginRequest>(error, FIELDS, setError));
    }
  });

  return (
    <AuthCard
      title="Sign in"
      failure={failure}
      footer={
        <span>
          New here? <Link href="/register">Create an account</Link>
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
          <Input type="email" autoComplete="username" autoFocus {...field('email')} />
        </Field>

        <Field label="Password" error={errors.password?.message}>
          <PasswordInput autoComplete="current-password" {...field('password')} />
        </Field>

        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text)]">
            <input
              type="checkbox"
              className="h-4 w-4 rounded-[var(--radius-control)] border border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              {...field('rememberMe')}
            />
            Keep me signed in
          </label>
          <Link
            href="/forgot-password"
            className="text-[length:var(--text-sm)] leading-[var(--leading-sm)]"
          >
            Forgot password?
          </Link>
        </div>

        <Button type="submit" pending={isSubmitting} className="w-full">
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthCard>
  );
}
