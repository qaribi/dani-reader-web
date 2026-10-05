import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsumerLifetime, consumeSearchResults, emptyReading, loadAndPublishReading,
  publishReading, retirePrivateWorkspace } from '../src/reader/consumer-lifetime.ts';
import type { PrivateWorkspaceSink } from '../src/reader/consumer-lifetime.ts';
import { ReaderSession, READER_BUILD } from '../src/reader/host-contract.ts';
import type { ControlFrame, ControlReply, HostTransport, ReaderContext, ReadingState } from '../src/reader/host-contract.ts';

type Match = { cfi: string; excerpt: string };
type Toc = { label: string; href: string };
const context: ReaderContext = {
  protocol: 1, readerBuild: READER_BUILD, sessionId: 'consumer-old', epoch: 1,
  presentationId: 'presentation-a', buildId: 'build-a', mode: 'local-unencrypted',
  resources: [{ id: 'chapter', href: 'EPUB/chapter.xhtml', mediaType: 'application/xhtml+xml', bytes: 3 }],
  permissions: { annotate: true, copy: false, print: false, export: false },
};
function reading(note = 'یادداشت پیشین', revision = 7): ReadingState {
  const locator = { schema: 1 as const, engine: 'readest-foliate' as const, engineVersion: READER_BUILD,
    scheme: 'epub-cfi' as const, value: 'epubcfi(/6/2!/4/2)', progression: 0.25 };
  return { revision, locator, unresolvedLegacyCount: 2,
    annotations: [{ id: 'note-a', revision: 1, kind: 'note', locator, note, deleted: false }] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
function reply(frame: ControlFrame, data: unknown): ControlReply {
  return { protocol: 1, requestId: frame.requestId, sessionId: frame.sessionId,
    epoch: frame.epoch, ok: true, data };
}
function workspace() {
  const ui = { reading: reading(), matches: [{ cfi: 'old-cfi', excerpt: 'متن خصوصی پیشین' }],
    toc: [{ label: 'فصل خصوصی', href: 'old' }], note: 'پیش‌نویس خصوصی', query: 'عبارت خصوصی',
    context: context as ReaderContext | null, status: 'active',
    sessionRef: 'old-session' as string | null, viewRef: 'old-view' as string | null,
    selectionRef: 'old-selection' as string | null };
  const sink: PrivateWorkspaceSink<Match, Toc> = {
    readingRef: { current: ui.reading },
    clearRefs: () => { ui.sessionRef = null; ui.viewRef = null; ui.selectionRef = null; },
    setReading: value => { ui.reading = value; }, setMatches: value => { ui.matches = value; },
    setToc: value => { ui.toc = value; }, setNote: value => { ui.note = value; },
    setQuery: value => { ui.query = value; }, setContext: value => { ui.context = value; },
    setStatus: value => { ui.status = value; },
  };
  return { ui, sink };
}
function assertCleared({ ui, sink }: ReturnType<typeof workspace>) {
  assert.deepEqual(ui.reading, emptyReading()); assert.deepEqual(sink.readingRef.current, emptyReading());
  assert.deepEqual(ui.matches, []); assert.deepEqual(ui.toc, []);
  assert.equal(ui.note, ''); assert.equal(ui.query, ''); assert.equal(ui.context, null);
  assert.equal(ui.sessionRef, null); assert.equal(ui.viewRef, null); assert.equal(ui.selectionRef, null);
}

test('engine progress notifications never become clickable search matches', async () => {
  const owner = new ConsumerLifetime(); const token = owner.begin(); const target = workspace();
  async function* results() {
    yield { progress: 0.5 };
    yield { subitems: [{ cfi: 'epubcfi(/6/2!/4/2)', excerpt: 'نتیجهٔ تألیفی' }] };
    yield 'done';
  }
  await consumeSearchResults(owner, token, target.sink, results());
  assert.deepEqual(target.ui.matches, [{ cfi: 'epubcfi(/6/2!/4/2)', excerpt: 'نتیجهٔ تألیفی' }]);
});

test('actual host load accepted in the private/public microtask gap cannot republish retired private UI', async () => {
  const owner = new ConsumerLifetime(); const token = owner.begin(); const target = workspace();
  const loadReply = deferred<ControlReply>(); let loadFrame!: ControlFrame;
  const transport: HostTransport = {
    control: frame => {
      if (frame.operation === 'initializeReader') return Promise.resolve(reply(frame, context));
      loadFrame = frame; return loadReply.promise;
    },
    resource: async () => new Uint8Array([1, 2, 3]).buffer,
  };
  const host = new ReaderSession(transport); await host.initialize();
  let validatedLoad = false;
  const pending = loadAndPublishReading(owner, token, target.sink, async () => {
    const value = await host.loadState(); validatedLoad = true; return value;
  });
  // abortable's reaction is already registered. Its resolution queues #request
  // before this retirement microtask; the subsequent public UI continuation is
  // deliberately later. This exercises the real host path, not a mocked fence.
  const invalidation = loadReply.promise.then(() => queueMicrotask(() => {
    retirePrivateWorkspace(owner, token, target.sink, 'trusted-logout'); host.invalidate();
  }));
  loadReply.resolve(reply(loadFrame, reading()));
  assert.equal(await pending, false); await invalidation;
  assert.equal(validatedLoad, true); assert.equal(host.context, null);
  assertCleared(target); assert.equal(target.ui.status, 'trusted-logout');
});

test('explicit exit retires before waiting for an already pending state load', async () => {
  const owner = new ConsumerLifetime(); const token = owner.begin(); const target = workspace();
  const load = deferred<ReadingState>();
  const pending = loadAndPublishReading(owner, token, target.sink, () => load.promise);
  retirePrivateWorkspace(owner, token, target.sink, 'exit');
  assertCleared(target); // Synchronous: no await of the pending load/close first.
  load.resolve(reading()); assert.equal(await pending, false); assertCleared(target);
});

for (const reason of ['trusted-logout', 'explicit-exit']) {
  test('late search result after ' + reason + ' cannot restore private excerpts', async () => {
    const owner = new ConsumerLifetime(); const token = owner.begin(); const target = workspace();
    const result = deferred<Match>(); let closed = false;
    const results = (async function* () {
      try { yield await result.promise; } finally { closed = true; }
    })();
    const pending = consumeSearchResults(owner, token, target.sink, results);
    retirePrivateWorkspace(owner, token, target.sink, reason);
    result.resolve({ cfi: 'late-cfi', excerpt: 'نباید بازگردد' }); await pending;
    assertCleared(target); assert.equal(target.ui.status, reason); assert.equal(closed, true);
  });
}

test('old load/search continuations and old cleanup preserve a newer lifetime', async () => {
  const owner = new ConsumerLifetime(); const old = owner.begin(); const target = workspace();
  const load = deferred<ReadingState>(); const result = deferred<Match>();
  const loading = loadAndPublishReading(owner, old, target.sink, () => load.promise);
  const searching = consumeSearchResults(owner, old, target.sink,
    (async function* () { yield await result.promise; })());
  retirePrivateWorkspace(owner, old, target.sink, 'retired');
  const newer = owner.begin(); const newState = reading('یادداشت نشست جدید', 9);
  publishReading(owner, newer, target.sink, newState);
  owner.publish(newer, () => {
    target.ui.sessionRef = 'new-session'; target.ui.viewRef = 'new-view'; target.ui.selectionRef = 'new-selection';
    target.ui.context = { ...context, sessionId: 'consumer-new', epoch: 2 };
    target.ui.note = 'new-draft'; target.ui.query = 'new-query'; target.ui.status = 'new-active';
    target.ui.matches = [{ cfi: 'new-cfi', excerpt: 'متن نشست جدید' }];
    target.ui.toc = [{ label: 'new-toc', href: 'new' }];
  });
  const before = structuredClone(target.ui);
  load.resolve(reading()); result.resolve({ cfi: 'old-cfi', excerpt: 'متن قدیمی' });
  assert.equal(await loading, false); await searching;
  assert.equal(retirePrivateWorkspace(owner, old, target.sink, 'old-cleanup'), false);
  assert.deepEqual(target.ui, before); assert.deepEqual(target.sink.readingRef.current, newState);
  assert.equal(owner.isCurrent(newer), true);
});

test('active lifetime still publishes validated reading state and search excerpts', async () => {
  const owner = new ConsumerLifetime(); const token = owner.begin(); const target = workspace();
  const newState = reading('فعال', 8);
  assert.equal(await loadAndPublishReading(owner, token, target.sink, async () => newState), true);
  await consumeSearchResults(owner, token, target.sink, (async function* () {
    yield 'progress'; yield { subitems: [{ cfi: 'active-cfi', excerpt: 'متن فعال' }] }; yield 'done';
  })());
  assert.deepEqual(target.ui.reading, newState); assert.deepEqual(target.sink.readingRef.current, newState);
  assert.deepEqual(target.ui.matches, [{ cfi: 'active-cfi', excerpt: 'متن فعال' }]);
});

test('retirement clear stops if a setter starts a newer lifetime reentrantly', () => {
  const owner = new ConsumerLifetime(); const old = owner.begin(); const target = workspace();
  const original = target.sink.setReading;
  const newState = reading('new-during-clear', 10);
  target.sink.setReading = value => {
    original(value);
    if (value.revision === 0) {
      const newer = owner.begin(); publishReading(owner, newer, target.sink, newState);
      owner.publish(newer, () => { target.ui.note = 'new-note'; target.ui.matches = [{ cfi: 'new', excerpt: 'new' }]; });
    }
  };
  retirePrivateWorkspace(owner, old, target.sink, 'old-status');
  assert.deepEqual(target.ui.reading, newState); assert.deepEqual(target.sink.readingRef.current, newState);
  assert.equal(target.ui.note, 'new-note'); assert.deepEqual(target.ui.matches, [{ cfi: 'new', excerpt: 'new' }]);
  assert.notEqual(target.ui.status, 'old-status');
});
