import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalTransport } from '../src/library/local-transport.ts';
import type { ImportedBook } from '../src/library/archive.ts';
import type { LocalLibrary } from '../src/library/database.ts';
import { ReaderSession, ReaderHostError, READER_BUILD } from '../src/reader/host-contract.ts';
import type { ReadingState } from '../src/reader/host-contract.ts';
import { emptyReading } from '../src/reader/consumer-lifetime.ts';

function setup() {
  const states = new Map<string, ReadingState>();
  const library = {
    async state(id: string) { return structuredClone(states.get(id) ?? emptyReading()); },
    async updateState(id: string, revision: number, mutate: (state: ReadingState) => ReadingState, signal: AbortSignal) {
      const state = structuredClone(states.get(id) ?? emptyReading());
      if (signal.aborted) throw new ReaderHostError('STALE_SESSION');
      if (state.revision !== revision) throw new ReaderHostError('CONFLICT');
      const next = mutate(state); next.revision++; states.set(id, structuredClone(next)); return next;
    },
  } as unknown as LocalLibrary;
  const book = (id: string): ImportedBook => ({ id, title: 'Original', language: 'fa', addedAt: 0, inputBytes: 3,
    expandedBytes: 3, resources: { 'chapter.xhtml': new Uint8Array([1, 2, 3]).buffer }, mediaTypes: { 'chapter.xhtml': 'application/xhtml+xml' } });
  return { library, book };
}
const position = { schema: 1 as const, engine: 'readest-foliate' as const, engineVersion: READER_BUILD,
  scheme: 'epub-cfi' as const, value: 'epubcfi(/6/2!/4/2)', progression: 0.3 };

test('content-hash books own separate progress and notes; revision conflicts cannot overwrite', async () => {
  const { library, book } = setup();
  const a = new ReaderSession(new LocalTransport(book('a'.repeat(64)), library));
  const b = new ReaderSession(new LocalTransport(book('b'.repeat(64)), library));
  await a.initialize(); await b.initialize();
  await a.saveProgress(position, 0);
  await assert.rejects(a.saveProgress(position, 0), (error: unknown) => error instanceof ReaderHostError && error.code === 'CONFLICT');
  await a.saveAnnotation({ id: 'original-note', revision: 0, kind: 'note', locator: position, note: 'متن تألیفی', deleted: false }, 1);
  assert.equal((await a.loadState()).annotations[0].note, 'متن تألیفی');
  assert.deepEqual(await b.loadState(), emptyReading());
  await a.close(); await b.close();
});
test('resource replies are detached; cross-session and disposed reads are denied', async () => {
  const { library, book } = setup();
  const transport = new LocalTransport(book('a'.repeat(64)), library);
  const session = new ReaderSession(transport); const context = await session.initialize();
  const first = await session.resource('chapter.xhtml'); new Uint8Array(first)[0] = 255;
  assert.equal(new Uint8Array(await session.resource('chapter.xhtml'))[0], 1);
  await assert.rejects(transport.resource({ ...context, sessionId: 'other' }, context.resources[0], new AbortController().signal));
  await session.close(); await assert.rejects(session.resource('chapter.xhtml'));
});

test('a resource-rich local book fits the separate bounded manifest budget', async () => {
  const { library, book } = setup();
  const rich = book('c'.repeat(64));
  for (let index = 0; index < 250; index++) {
    rich.resources['EPUB/original-resource-' + index + '.bin'] = new Uint8Array(100).buffer;
  }
  const session = new ReaderSession(new LocalTransport(rich, library));
  assert.equal((await session.initialize()).resources.length, 251);
  await session.close();
});

test('manifest cap is still enforced independently of resource count', () => {
  const { library, book } = setup(); const rich = book('d'.repeat(64));
  for (let index = 0; index < 200; index++) {
    rich.resources['EPUB/' + 'a'.repeat(800) + index + '.bin'] = new Uint8Array(1).buffer;
  }
  assert.throws(() => new LocalTransport(rich, library), (error: unknown) => error instanceof ReaderHostError && error.code === 'LIMIT');
});
