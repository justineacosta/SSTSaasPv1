import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RECOVERY_CODES_WARNING, RecoveryCodes } from './RecoveryCodes';

const CODES = [
  'abcd-efghi',
  'jklm-nopqr',
  'stuv-wxyza',
  'bcde-fghij',
  'klmn-opqrs',
  'tuvw-xyzab',
  'cdef-ghijk',
  'lmno-pqrst',
  'uvwx-yzabc',
  'defg-hijkl',
];

describe('RecoveryCodes — the once-only warning', () => {
  it('STATES PLAINLY THAT THE CODES WILL NOT BE SHOWN AGAIN', () => {
    // The assertion this component exists for. `api/authentication.md` §2:
    // recovery codes are "shown once. No endpoint reads any of them back" —
    // they are stored as Argon2id hashes, so this render is the only copy that
    // will ever exist. §4 requires the same statement for API keys, and a
    // once-only secret rendered without it is a support ticket at best.
    render(<RecoveryCodes codes={CODES} />);

    expect(screen.getByText(RECOVERY_CODES_WARNING)).toBeInTheDocument();
    expect(RECOVERY_CODES_WARNING).toContain('will not be shown again');
  });

  it('renders every code it was given', () => {
    render(<RecoveryCodes codes={CODES} />);
    for (const code of CODES) expect(screen.getByText(code)).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(CODES.length);
  });

  it('offers both copy and download', () => {
    // `api/authentication.md` §4: "the UI states this before generation and
    // offers copy and download".
    render(<RecoveryCodes codes={CODES} />);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });

  it('copies every code, newline-separated, in the order shown', async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    render(<RecoveryCodes codes={CODES} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(writeText).toHaveBeenCalledWith(CODES.join('\n'));
    expect(await screen.findByText('Copied to the clipboard.')).toBeInTheDocument();
  });

  it('does not claim success when the clipboard refuses', async () => {
    const writeText = vi
      .fn<(value: string) => Promise<void>>()
      .mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    render(<RecoveryCodes codes={CODES} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(screen.queryByText('Copied to the clipboard.')).not.toBeInTheDocument();
    // The codes are still on screen and can be selected by hand, which is why a
    // refused clipboard is not an error state.
    expect(screen.getByText(CODES[0] ?? '')).toBeInTheDocument();
  });

  it('does not render a done button when there is nothing to do next', () => {
    render(<RecoveryCodes codes={CODES} />);
    expect(screen.queryByRole('button', { name: 'I have saved them' })).not.toBeInTheDocument();
  });

  it('calls onDone only when the user says they have saved them', async () => {
    const onDone = vi.fn();
    render(<RecoveryCodes codes={CODES} onDone={onDone} />);

    expect(onDone).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'I have saved them' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
