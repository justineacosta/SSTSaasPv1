import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ForgotPasswordScreen } from '../../../src/auth/ForgotPasswordScreen';

export const metadata: Metadata = { title: 'Reset your password' };

export default function ForgotPasswordPage(): ReactNode {
  return <ForgotPasswordScreen />;
}
