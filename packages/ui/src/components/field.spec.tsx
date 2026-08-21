import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Field } from './field.js';

describe('Field', () => {
  it('associates the label with the control', () => {
    render(
      <Field label="Organisation name">
        <input id="name" />
      </Field>,
    );
    expect(screen.getByLabelText('Organisation name')).toBeInTheDocument();
  });

  it('ties the error message to the control with aria-describedby', () => {
    render(
      <Field label="Email" error="Enter a valid email address.">
        <input id="email" />
      </Field>,
    );
    const input = screen.getByLabelText('Email');
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe('Enter a valid email address.');
  });

  it('marks the control invalid when there is an error', () => {
    render(
      <Field label="Email" error="Bad.">
        <input id="email" />
      </Field>,
    );
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
  });

  it('does not mark the control invalid without an error', () => {
    render(
      <Field label="Email">
        <input id="email" />
      </Field>,
    );
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid', 'true');
  });
});
