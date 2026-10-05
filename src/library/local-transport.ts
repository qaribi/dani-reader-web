import { READER_BUILD, READER_PROTOCOL, ReaderHostError, parseControlMessage, validateContext } from '../reader/host-contract.ts';
import type { Annotation, ControlFrame, ControlReply, HostTransport, Locator, ManifestResource, ReaderContext } from '../reader/host-contract.ts';
import type { ImportedBook } from './archive.ts';
import type { LocalLibrary } from './database.ts';

/** One local publication owns one session. No network, identity or rights adapter. */
export function localBookContext(book: ImportedBook): ReaderContext {
  return validateContext({ protocol: READER_PROTOCOL, readerBuild: READER_BUILD,
    sessionId: crypto.randomUUID(), epoch: 1, presentationId: book.id, buildId: book.id,
    mode: 'local-unencrypted', permissions: { annotate: true, copy: true, print: false, export: false },
    resources: Object.entries(book.resources).map(([href, bytes], index) => ({ id: 'r' + index, href,
      bytes: bytes.byteLength, mediaType: book.mediaTypes[href] ?? 'application/octet-stream' })) });
}

export class LocalTransport implements HostTransport {
  #context: ReaderContext;
  #closed = false;
  private book: ImportedBook;
  private library: LocalLibrary;
  constructor(book: ImportedBook, library: LocalLibrary) {
    this.book = book; this.library = library;
    this.#context = localBookContext(book);
  }
  dispose() { this.#closed = true; }
  #assert(signal: AbortSignal) {
    if (this.#closed || signal.aborted) throw new ReaderHostError('STALE_SESSION');
  }
  async control(input: ControlFrame, signal: AbortSignal): Promise<ControlReply> {
    const frame = parseControlMessage(input);
    const reply = { protocol: READER_PROTOCOL, requestId: frame.requestId,
      sessionId: this.#context.sessionId, epoch: this.#context.epoch };
    try {
      this.#assert(signal);
      if (frame.operation !== 'initializeReader' && (frame.sessionId !== this.#context.sessionId || frame.epoch !== this.#context.epoch)) {
        throw new ReaderHostError('STALE_SESSION');
      }
      let data: unknown;
      if (frame.operation === 'initializeReader') {
        if (frame.payload.readerBuild !== READER_BUILD) throw new ReaderHostError('DENIED');
        data = structuredClone(this.#context);
      } else if (frame.operation === 'loadReadingState') data = await this.library.state(this.book.id);
      else if (frame.operation === 'closeReader') { this.dispose(); data = {}; }
      else {
        data = await this.library.updateState(this.book.id, frame.payload.expectedRevision as number, state => {
          if (frame.operation === 'saveProgress') state.locator = frame.payload.locator as Locator;
          else {
            const annotation = frame.payload.annotation as Annotation;
            const index = state.annotations.findIndex(item => item.id === annotation.id);
            if (index < 0 && annotation.deleted) throw new ReaderHostError('CONFLICT');
            const next = { ...annotation, revision: state.revision + 1 };
            if (annotation.deleted) state.annotations.splice(index, 1);
            else if (index < 0) state.annotations.push(next); else state.annotations[index] = next;
          }
          return state;
        }, signal);
      }
      if (frame.operation !== 'closeReader') this.#assert(signal);
      return { ...reply, ok: true, data };
    } catch (error) {
      return { ...reply, ok: false, error: error instanceof ReaderHostError ? error.code : 'UNAVAILABLE' };
    }
  }
  async resource(context: ReaderContext, resource: ManifestResource, signal: AbortSignal): Promise<ArrayBuffer> {
    this.#assert(signal);
    if (context.sessionId !== this.#context.sessionId || context.epoch !== this.#context.epoch
      || !this.#context.resources.some(item => item.id === resource.id && item.href === resource.href)) throw new ReaderHostError('DENIED');
    const bytes = this.book.resources[resource.href];
    if (!bytes || bytes.byteLength !== resource.bytes) throw new ReaderHostError('INTEGRITY');
    return bytes.slice(0);
  }
}
