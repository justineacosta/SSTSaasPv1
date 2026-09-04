'use client';

import { Input } from '@sentinel/ui';
import { forwardRef, useState, type InputHTMLAttributes } from 'react';

export type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

/**
 * A password input with a reveal toggle.
 *
 * `forms.md` §5 asks for three things and this is all three: the `autocomplete`
 * value is the caller's to set correctly (`current-password` or
 * `new-password`), there is a reveal toggle, and **paste is not blocked** —
 * blocking it breaks password managers and makes passwords weaker, which is the
 * opposite of the intent.
 *
 * Written to be `Field`'s single child: `Field` clones its child and sets `id`,
 * `aria-describedby` and `aria-invalid` on it, so those props have to land on
 * the `<input>` rather than on the wrapper. That is why this forwards
 * everything it is given straight through and keeps only the toggle for itself.
 *
 * The toggle is `tabIndex={-1}` deliberately: it sits between the password
 * field and the submit button in DOM order, and a keyboard user tabbing out of
 * the password should reach the button, not a decorative control they can also
 * reach with a screen reader's own navigation. It stays a real `<button>` with
 * an accessible name, so it is operable — `accessibility.md` §2's rule is that
 * everything operable by mouse is operable by keyboard, not that everything is
 * in the tab ring.
 */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, ...props }, ref) => {
    const [revealed, setRevealed] = useState(false);
    return (
      <div className="relative">
        <Input
          ref={ref}
          type={revealed ? 'text' : 'password'}
          className={`pr-16 ${className ?? ''}`}
          {...props}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => {
            setRevealed((current) => !current);
          }}
          aria-pressed={revealed}
          className="absolute inset-y-0 right-0 px-3 text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          {revealed ? 'Hide' : 'Show'}
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = 'PasswordInput';
