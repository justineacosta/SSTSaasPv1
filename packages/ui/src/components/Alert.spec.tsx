import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Alert } from './Alert.js';

describe('Alert', () => {
  it('announces as the assertive role for the danger variant', () => {
    render(<Alert variant="danger">Scan failed.</Alert>);
    expect(screen.getByRole('alert')).toHaveTextContent('Scan failed.');
  });

  it('announces as the polite status role for a non-danger variant', () => {
    render(<Alert variant="success">Scan started.</Alert>);
    expect(screen.getByRole('status')).toHaveTextContent('Scan started.');
  });

  it('lets an explicit role override the variant default', () => {
    render(
      <Alert variant="danger" role="status">
        Retrying.
      </Alert>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Retrying.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
