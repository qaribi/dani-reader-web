import { LIMITS } from './host-contract.ts';
import type { ReaderContext, ReadingState } from './host-contract.ts';

export type ConsumerToken = Readonly<{ generation: number }>;

/** A UI publication fence only. It does not grant native session/rights. */
export class ConsumerLifetime {
  #generation = 0;
  #current: ConsumerToken | null = null;
  get current() { return this.#current; }
  begin(): ConsumerToken {
    this.#current = Object.freeze({ generation: ++this.#generation });
    return this.#current;
  }
  isCurrent(token: ConsumerToken): boolean { return this.#current === token; }
  publish(token: ConsumerToken, ...steps: (() => void)[]): boolean {
    for (const step of steps) {
      // Each actual mutation is fenced, including reentrant setter callbacks.
      if (!this.isCurrent(token)) return false;
      step();
    }
    return this.isCurrent(token);
  }
  retire(token: ConsumerToken, ...clearSteps: (() => void)[]): boolean {
    if (!this.isCurrent(token)) return false;
    this.#current = null;
    const retiredGeneration = ++this.#generation; // Retire before any clear.
    for (const clear of clearSteps) {
      // An old cleanup cannot clear a newer lifetime, even if a setter reenters.
      if (this.#current !== null || this.#generation !== retiredGeneration) break;
      clear();
    }
    return true;
  }
}

export const emptyReading = (): ReadingState => ({
  revision: 0, locator: null, annotations: [], unresolvedLegacyCount: 0,
});
export interface PrivateWorkspaceSink<Match, Toc> {
  readingRef: { current: ReadingState };
  clearRefs(): void;
  setReading(value: ReadingState): void;
  setMatches(value: Match[]): void;
  setToc(value: Toc[]): void;
  setNote(value: string): void;
  setQuery(value: string): void;
  setContext(value: ReaderContext | null): void;
  setStatus(value: string): void;
}
function clearSteps<Match, Toc>(sink: PrivateWorkspaceSink<Match, Toc>, status: string): (() => void)[] {
  const reading = emptyReading();
  return [() => sink.clearRefs(), () => { sink.readingRef.current = reading; },
    () => sink.setReading(reading), () => sink.setMatches([]), () => sink.setToc([]),
    () => sink.setNote(''), () => sink.setQuery(''), () => sink.setContext(null),
    () => sink.setStatus(status)];
}
export function clearPrivateWorkspace<Match, Toc>(owner: ConsumerLifetime, token: ConsumerToken,
  sink: PrivateWorkspaceSink<Match, Toc>, status: string): boolean {
  return owner.publish(token, ...clearSteps(sink, status));
}
export function retirePrivateWorkspace<Match, Toc>(owner: ConsumerLifetime, token: ConsumerToken,
  sink: PrivateWorkspaceSink<Match, Toc>, status: string): boolean {
  return owner.retire(token, ...clearSteps(sink, status));
}
export function publishReading<Match, Toc>(owner: ConsumerLifetime, token: ConsumerToken,
  sink: PrivateWorkspaceSink<Match, Toc>, reading: ReadingState): boolean {
  return owner.publish(token, () => { sink.readingRef.current = reading; }, () => sink.setReading(reading));
}
export async function loadAndPublishReading<Match, Toc>(owner: ConsumerLifetime, token: ConsumerToken,
  sink: PrivateWorkspaceSink<Match, Toc>, load: () => Promise<ReadingState>): Promise<boolean> {
  const reading = await load();
  return publishReading(owner, token, sink, reading);
}

export type SearchItem = { cfi: string };
export async function consumeSearchResults<Match extends SearchItem, Toc>(owner: ConsumerLifetime,
  token: ConsumerToken, sink: PrivateWorkspaceSink<Match, Toc>,
  results: AsyncIterable<Match | { subitems: Match[] } | { progress: number } | string>): Promise<void> {
  const found: Match[] = [];
  for await (const result of results) {
    if (!owner.isCurrent(token)) return;
    if (typeof result === 'string') continue;
    const items = 'subitems' in result ? result.subitems : [result];
    const addition = items.filter((item): item is Match => 'cfi' in item && typeof item.cfi === 'string')
      .slice(0, LIMITS.searchResults - found.length);
    if (!addition.length) continue;
    if (!owner.publish(token, () => { found.push(...addition); }, () => sink.setMatches([...found]))) return;
    if (found.length >= LIMITS.searchResults) return;
  }
}
