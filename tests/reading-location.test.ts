import assert from 'node:assert/strict';
import test from 'node:test';
import { readingLocator } from '../src/reader/reading-location.ts';
import { validateLocator } from '../src/reader/host-contract.ts';

test('short-book overshoot retains a valid CFI and produces persistable end progress', () => {
  const cfi = 'epubcfi(/6/2!/4,/2[one],/6/1:39)';
  const location = readingLocator(cfi, 2);
  assert.equal(location.value, cfi);
  assert.equal(location.progression, 1);
  assert.doesNotThrow(() => validateLocator(location));
});

test('layout fractions stay finite and bounded without inventing unknown progress', () => {
  const cfi = 'epubcfi(/6/2!/4/2:0)';
  assert.equal(readingLocator(cfi, -0.5).progression, 0);
  assert.equal(readingLocator(cfi, 0.42).progression, 0.42);
  for (const fraction of [NaN, Infinity, -Infinity, undefined, '0.5'])
    assert.equal(readingLocator(cfi, fraction).progression, undefined);
});
