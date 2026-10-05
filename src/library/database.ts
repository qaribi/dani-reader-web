import type { ImportedBook } from './archive.ts';
import { LIMITS, ReaderHostError, validateAnnotation, validateLocator } from '../reader/host-contract.ts';
import type { ReadingState } from '../reader/host-contract.ts';
import { emptyReading } from '../reader/consumer-lifetime.ts';

export type ReadingSettings = { fontSize: number; lineHeight: number; theme: 'light' | 'sepia' | 'dark'; flow: 'paginated' | 'scrolled' };
export const defaultSettings = (): ReadingSettings => ({ fontSize: 20, lineHeight: 1.8, theme: 'light', flow: 'paginated' });
export function validSettings(value: unknown): value is ReadingSettings {
  if (!value || typeof value !== 'object') return false;
  const item = value as ReadingSettings;
  return Number.isFinite(item.fontSize) && item.fontSize >= 14 && item.fontSize <= 40
    && Number.isFinite(item.lineHeight) && item.lineHeight >= 1.2 && item.lineHeight <= 3
    && ['light', 'sepia', 'dark'].includes(item.theme) && ['paginated', 'scrolled'].includes(item.flow);
}
function transactionResult<T>(tx: IDBTransaction, value: () => T, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { try { tx.abort(); } catch { /* Already completed. */ } };
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', abort);
    tx.oncomplete = () => { cleanup(); resolve(value()); };
    tx.onabort = tx.onerror = () => { cleanup(); reject(new ReaderHostError(signal?.aborted ? 'STALE_SESSION' : 'STORAGE')); };
  });
}

export class LocalLibrary {
  #db: Promise<IDBDatabase>;
  constructor() {
    this.#db = new Promise((resolve, reject) => {
      const request = indexedDB.open('dani-reader-web-local-v1', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('books', { keyPath: 'id' });
        db.createObjectStore('states', { keyPath: 'id' });
        db.createObjectStore('settings');
      };
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = request.onblocked = () => reject(new ReaderHostError('STORAGE'));
    });
  }
  async list(): Promise<ImportedBook[]> {
    const tx = (await this.#db).transaction('books', 'readonly');
    const request = tx.objectStore('books').getAll();
    return transactionResult(tx, () => request.result as ImportedBook[]);
  }
  async put(book: ImportedBook): Promise<void> {
    const tx = (await this.#db).transaction('books', 'readwrite');
    const store = tx.objectStore('books');
    const existing = store.getAll();
    let tooLarge = false;
    existing.onsuccess = () => {
      const total = (existing.result as ImportedBook[]).filter(item => item.id !== book.id).reduce((sum, item) => sum + item.expandedBytes, book.expandedBytes);
      if (total > 128 * 1024 * 1024 || existing.result.length >= 64 && !existing.result.some((item: ImportedBook) => item.id === book.id)) {
        tooLarge = true; tx.abort(); return;
      }
      store.put(book);
    };
    try { await transactionResult(tx, () => undefined); } catch (error) { if (tooLarge) throw new ReaderHostError('LIMIT'); throw error; }
  }
  async remove(id: string): Promise<void> {
    const tx = (await this.#db).transaction(['books', 'states'], 'readwrite');
    tx.objectStore('books').delete(id); tx.objectStore('states').delete(id);
    await transactionResult(tx, () => undefined);
  }
  async state(id: string): Promise<ReadingState> {
    const tx = (await this.#db).transaction('states', 'readonly');
    const request = tx.objectStore('states').get(id);
    return transactionResult(tx, () => request.result?.state ?? emptyReading());
  }
  async updateState(id: string, expectedRevision: number, mutate: (state: ReadingState) => ReadingState, signal: AbortSignal): Promise<ReadingState> {
    const tx = (await this.#db).transaction('states', 'readwrite');
    const store = tx.objectStore('states');
    const request = store.get(id);
    let result: ReadingState = emptyReading(), failure: ReaderHostError | null = null;
    request.onsuccess = () => {
      try {
        if (signal.aborted) throw new ReaderHostError('STALE_SESSION');
        const current: ReadingState = request.result?.state ?? emptyReading();
        if (current.revision !== expectedRevision) throw new ReaderHostError('CONFLICT');
        result = mutate(structuredClone(current));
        result.revision = current.revision + 1;
        if (result.locator) validateLocator(result.locator);
        for (const annotation of result.annotations) validateAnnotation(annotation);
        if (result.annotations.length > LIMITS.annotations || new TextEncoder().encode(JSON.stringify(result)).length > LIMITS.stateBytes) {
          throw new ReaderHostError('LIMIT');
        }
        store.put({ id, state: result });
      } catch (error) { failure = error instanceof ReaderHostError ? error : new ReaderHostError('UNAVAILABLE'); tx.abort(); }
    };
    try { return await transactionResult(tx, () => result, signal); } catch (error) { throw failure ?? error; }
  }
  async settings(): Promise<ReadingSettings> {
    const tx = (await this.#db).transaction('settings', 'readonly');
    const request = tx.objectStore('settings').get('reading');
    return transactionResult(tx, () => validSettings(request.result) ? request.result : defaultSettings());
  }
  async saveSettings(settings: ReadingSettings): Promise<void> {
    if (!validSettings(settings)) throw new ReaderHostError('INVALID_MESSAGE');
    const tx = (await this.#db).transaction('settings', 'readwrite');
    tx.objectStore('settings').put(settings, 'reading');
    await transactionResult(tx, () => undefined);
  }
}
