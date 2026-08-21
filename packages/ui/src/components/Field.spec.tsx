import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Field } from './Field.js';
import { Input } from './Input.js';

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

  it("preserves a control's own aria-describedby, merging in the description", () => {
    // The referenced element deliberately lives outside Field's children —
    // Field only ever receives one child, so this exercises the realistic
    // case of a control that already points at a description elsewhere in
    // the layout.
    render(
      <div>
        <Field label="Password" description="At least 12 characters.">
          <input id="password" aria-describedby="pw-rules" />
        </Field>
        <span id="pw-rules">Mix of upper and lower case.</span>
      </div>,
    );
    const describedBy = screen.getByLabelText('Password').getAttribute('aria-describedby') ?? '';
    const ids = describedBy.split(' ');
    expect(ids).toContain('pw-rules');
    expect(document.getElementById('pw-rules')?.textContent).toBe('Mix of upper and lower case.');
    const descriptionText = ids
      .map((id) => document.getElementById(id)?.textContent)
      .find((text) => text === 'At least 12 characters.');
    expect(descriptionText).toBe('At least 12 characters.');
  });

  it("leaves a control's own aria-invalid alone when there is no error", () => {
    render(
      <Field label="Email">
        <input id="email" aria-invalid="true" />
      </Field>,
    );
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
  });

  it('generates an id for a control that supplies none, still associating the label', () => {
    render(
      <Field label="Organisation name">
        <Input />
      </Field>,
    );
    expect(screen.getByLabelText('Organisation name')).toBeInTheDocument();
  });
});
