import { READER_BUILD } from './host-contract.ts';
import type { Locator } from './host-contract.ts';

/** Layout-derived fractions can exceed the book bounds for a one-screen book. */
export const readingLocator = (cfi: string, fraction?: unknown): Locator => ({
  schema: 1, engine: 'readest-foliate', engineVersion: READER_BUILD,
  scheme: 'epub-cfi', value: cfi,
  ...(typeof fraction === 'number' && Number.isFinite(fraction)
    ? { progression: Math.min(1, Math.max(0, fraction)) } : {}),
});
