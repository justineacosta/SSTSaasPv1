// Registers jest-dom's matchers (toBeInTheDocument, toHaveAttribute, ...)
// against vitest's `expect`. Wired in as the 'ui' vitest project's
// setupFiles — see vitest.workspace.ts.
import '@testing-library/jest-dom/vitest';

import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// @testing-library/react only self-registers this via a bare `afterEach`
// global, which requires vitest's `test.globals: true`. This workspace
// doesn't turn that on for any project (specs import `afterEach` explicitly
// instead), so without this the DOM from one test's render() is still
// mounted when the next test in the same file runs.
afterEach(cleanup);
