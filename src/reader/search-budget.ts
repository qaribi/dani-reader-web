import { LIMITS, ReaderHostError } from './host-contract.ts';

/** One global budget for the entire contains search, never reset per section. */
export class SearchBudget {
  #remaining = LIMITS.searchResults;
  get remaining() { return this.#remaining; }
  * mapMatches<Match, Result>(matches: Iterable<Match>, map: (match: Match) => Result,
    active: () => boolean = () => true): Generator<Result> {
    const iterator = matches[Symbol.iterator]();
    try {
      // Check BEFORE next(): the matcher allocates its excerpt/range at next().
      while (this.#remaining > 0 && active()) {
        const next = iterator.next();
        if (next.done || !active()) return;
        this.#remaining--;
        yield map(next.value); // CFI/allocation only for an admitted match.
      }
    } finally { iterator.return?.(); }
  }
}
export function highlightSearchMatches(matches: readonly { cfi: string }[], seen: Set<string>,
  add: (cfi: string) => void, active: () => boolean = () => true): void {
  if (matches.length > LIMITS.searchResults) throw new ReaderHostError('LIMIT');
  for (const match of matches) {
    if (!active()) return;
    if (seen.has(match.cfi)) continue;
    seen.add(match.cfi);
    add(match.cfi);
  }
}
