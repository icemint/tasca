import { vi } from 'vitest';

// Force the PRODUCTION client path: with DEV falsy, useMock() returns false and the
// api client always fetches (the dev-fixtures branch is dead), so tests drive every
// state by stubbing `fetch` instead of getting fixture data.
vi.stubEnv('DEV', false);
