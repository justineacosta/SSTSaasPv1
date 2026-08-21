import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
// A default import types as the whole module namespace here (nodenext +
// esModuleInterop, against this package's conditional exports map, which
// has no explicit "import" condition) — verified empirically. The named
// export is the same object and types correctly.
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button.js';

describe('Button', () => {
  it('renders its children as the accessible name', () => {
    render(<Button>Start scan</Button>);
    expect(screen.getByRole('button', { name: 'Start scan' })).toBeInTheDocument();
  });

  it('does not fire onClick while disabled', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Start scan
      </Button>,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('forwards a ref to the underlying button element', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Start scan</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it('uses no raw hex colour in its class output', () => {
    const { container } = render(<Button variant="danger">Revoke key</Button>);
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
