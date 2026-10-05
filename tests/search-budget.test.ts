import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchBudget, highlightSearchMatches } from '../src/reader/search-budget.ts';
import { LIMITS } from '../src/reader/host-contract.ts';
import { searchMatcher } from '../vendor/foliate-js/search.js';

// The pinned real matcher/excerpt code runs against a single synthetic text
// node. DOM Range and CFI construction are counted at their actual admission
// boundary; no browser/native/security qualification is inferred from this.
type FakeRange = { startIndex: number; startOffset: number; endIndex: number; endOffset: number };
type FakeDoc = { text: string; body: { lang: string }; documentElement: { lang: string } };
type RawMatch = { range: FakeRange; excerpt: { pre: string; match: string; post: string } };
function* walker(doc: FakeDoc, walk: (strs: string[], range: (...offsets: number[]) => FakeRange) => Iterable<RawMatch>) {
  yield* walk([doc.text], (startIndex, startOffset, endIndex, endOffset) => ({ startIndex, startOffset, endIndex, endOffset }));
}
const matcher = searchMatcher(walker, { defaultLocale: 'en', mode: 'contains', matchCase: false, matchWholeWords: false });
function section(matches: number) {
  const counters = { produced: 0, range: 0, cfi: 0, result: 0, highlight: 0, closed: false };
  const doc: FakeDoc = { text: 'needle '.repeat(matches) + 'end', body: { lang: 'en' }, documentElement: { lang: 'en' } };
  assert.ok(new TextEncoder().encode(doc.text).byteLength < LIMITS.resourceBytes);
  const raw = (function* () {
    try {
      for (const match of matcher(doc, 'needle')) {
        counters.produced++; counters.range++; yield match as RawMatch;
      }
    } finally { counters.closed = true; }
  })();
  return { counters, raw };
}
function collect(budget: SearchBudget, source: ReturnType<typeof section>, index: number) {
  const subitems = Array.from(budget.mapMatches(source.raw, match => {
    source.counters.cfi++; source.counters.result++;
    return { cfi: `epubcfi(section-${index}:${match.range.startOffset})`, excerpt: match.excerpt };
  }));
  highlightSearchMatches(subitems, new Set(), () => { source.counters.highlight++; });
  return subitems;
}
function assertAllocations(source: ReturnType<typeof section>, count: number) {
  for (const key of ['produced', 'range', 'cfi', 'result', 'highlight'] as const)
    assert.equal(source.counters[key], count, key);
}

test('under-budget real contains matcher retains excerpts and one CFI/highlight per match', () => {
  const budget = new SearchBudget(); const source = section(4); const found = collect(budget, source, 0);
  assert.equal(found.length, 4); assertAllocations(source, 4); assert.equal(source.counters.closed, true);
  assert.equal(budget.remaining, 96); assert.ok(found.every(match => match.excerpt.match === 'needle'));
});

test('more than 100 legal matches stop before the 101st matcher excerpt/range/CFI/highlight allocation', () => {
  const budget = new SearchBudget(); const source = section(2000); const found = collect(budget, source, 0);
  assert.equal(found.length, 100); assertAllocations(source, 100); assert.equal(source.counters.closed, true);
  assert.equal(budget.remaining, 0);
  const later = section(1000); assert.deepEqual(collect(budget, later, 1), []); assertAllocations(later, 0);
});

test('one global remaining budget spans sections rather than restarting at each section', () => {
  const budget = new SearchBudget(); const sources = [section(60), section(80), section(2000)];
  const found = sources.map((source, index) => collect(budget, source, index));
  assert.deepEqual(found.map(items => items.length), [60, 40, 0]);
  sources.forEach((source, index) => assertAllocations(source, [60, 40, 0][index]));
  assert.equal(budget.remaining, 0); assert.equal(found.flat().length, LIMITS.searchResults);
});
