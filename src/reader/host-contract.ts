// A local adapter binds every operation and resource to one imported content hash.
export const READER_PROTOCOL = 1 as const;
export const READER_BUILD = 'dani-reader-web-0.1.0' as const;
export const LIMITS = Object.freeze({
  controlBytes: 16_384,
  manifestBytes: 131_072,
  stateBytes: 262_144,
  pendingRequests: 8,
  resourceBytes: 2_097_152,
  publicationBytes: 67_108_864,
  resources: 512,
  noteBytes: 8192,
  annotations: 256,
  searchResults: 100,
  searchChars: 256,
  requestTimeoutMs: 15_000,
});

export type HostErrorCode = 'INVALID_MESSAGE' | 'LIMIT' | 'DENIED' | 'INTEGRITY'
  | 'STALE_SESSION' | 'UNAVAILABLE' | 'STORAGE' | 'CONFLICT' | 'NOT_IMPLEMENTED';
export class ReaderHostError extends Error {
  readonly code: HostErrorCode;
  constructor(code: HostErrorCode) {
    // Do not copy publication text, secret values or a received payload into errors.
    super(code);
    this.name = 'ReaderHostError';
    this.code = code;
  }
}

export type Locator = {
  schema: 1;
  engine: 'readest-foliate';
  engineVersion: typeof READER_BUILD;
  scheme: 'epub-cfi';
  value: string;
  progression?: number;
};
export type Annotation = {
  id: string;
  revision: number;
  kind: 'bookmark' | 'highlight' | 'note';
  locator: Locator;
  note?: string;
  deleted: boolean;
};
export type ReadingState = {
  revision: number;
  locator: Locator | null;
  annotations: Annotation[];
  unresolvedLegacyCount: number;
};
export type ManifestResource = {
  id: string;
  href: string;
  mediaType: string;
  bytes: number;
};
export type ReaderContext = {
  protocol: typeof READER_PROTOCOL;
  readerBuild: typeof READER_BUILD;
  sessionId: string;
  epoch: number;
  presentationId: string;
  buildId: string;
  mode: 'local-unencrypted';
  resources: ManifestResource[];
  permissions: { annotate: boolean; copy: boolean; print: boolean; export: boolean };
};
export type Operation = 'initializeReader' | 'loadReadingState' | 'saveProgress'
  | 'upsertAnnotation' | 'deleteAnnotation' | 'closeReader';
export type ControlFrame = {
  protocol: typeof READER_PROTOCOL;
  requestId: string;
  sessionId: string | null;
  epoch: number;
  operation: Operation;
  payload: Record<string, unknown>;
};
export type ControlReply = {
  protocol: typeof READER_PROTOCOL;
  requestId: string;
  sessionId: string | null;
  epoch: number;
  ok: boolean;
  data?: unknown;
  error?: HostErrorCode;
};
export interface HostTransport {
  control(frame: ControlFrame, signal: AbortSignal): Promise<ControlReply>;
  // Binary resources never traverse JSON/base64 control messages.
  resource(context: ReaderContext, resource: ManifestResource, signal: AbortSignal): Promise<ArrayBuffer>;
}

const allowedOperations = new Set<Operation>([
  'initializeReader', 'loadReadingState', 'saveProgress',
  'upsertAnnotation', 'deleteAnnotation', 'closeReader',
]);
const encoder = new TextEncoder();
const errorCodes = new Set<HostErrorCode>(['INVALID_MESSAGE', 'LIMIT', 'DENIED', 'INTEGRITY', 'STALE_SESSION', 'UNAVAILABLE', 'STORAGE', 'CONFLICT', 'NOT_IMPLEMENTED']);
const ownRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
export const byteLength = (value: string) => encoder.encode(value).byteLength;
const positiveEpoch = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
export const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

/** Manifest-relative paths only. Decode once, never accept a second encoded layer. */
export function canonicalResourcePath(input: string): string {
  if (typeof input !== 'string' || input.length > 1024 || /[\x00-\x1f\\?#:]/u.test(input)) {
    throw new ReaderHostError('DENIED');
  }
  let value: string;
  try { value = decodeURIComponent(input); } catch { throw new ReaderHostError('DENIED'); }
  if (/[\x00-\x1f\\%?#:]/u.test(value) || value.startsWith('/') || value.endsWith('/')) {
    throw new ReaderHostError('DENIED');
  }
  const segments = value.split('/');
  if (segments.some(part => !part || part === '.' || part === '..')) throw new ReaderHostError('DENIED');
  return segments.join('/');
}

export function validateLocator(value: unknown): asserts value is Locator {
  if (!ownRecord(value) || value.schema !== 1 || value.engine !== 'readest-foliate'
    || value.engineVersion !== READER_BUILD || value.scheme !== 'epub-cfi'
    || typeof value.value !== 'string' || value.value.length > 4096
    || !value.value.startsWith('epubcfi(') || !value.value.endsWith(')')
    || Object.keys(value).some(key => !['schema', 'engine', 'engineVersion', 'scheme', 'value', 'progression'].includes(key))
    || (value.progression !== undefined && (typeof value.progression !== 'number'
      || !Number.isFinite(value.progression) || value.progression < 0 || value.progression > 1))) {
    throw new ReaderHostError('INVALID_MESSAGE');
  }
}

export function parseControlMessage(value: unknown): ControlFrame {
  let frame: unknown = value;
  try {
    if (typeof value === 'string') {
      if (byteLength(value) > LIMITS.controlBytes) throw new ReaderHostError('LIMIT');
      frame = JSON.parse(value);
    } else if (byteLength(JSON.stringify(value)) > LIMITS.controlBytes) throw new ReaderHostError('LIMIT');
  } catch (error) {
    if (error instanceof ReaderHostError) throw error;
    throw new ReaderHostError('INVALID_MESSAGE');
  }
  if (!ownRecord(frame) || frame.protocol !== READER_PROTOCOL || !validId(frame.requestId)
    || !positiveEpoch(frame.epoch) || !allowedOperations.has(frame.operation as Operation)
    || !ownRecord(frame.payload) || (frame.sessionId !== null && !validId(frame.sessionId))
    || Object.keys(frame).some(key => !['protocol', 'requestId', 'sessionId', 'epoch', 'operation', 'payload'].includes(key))) {
    throw new ReaderHostError('INVALID_MESSAGE');
  }
  if (frame.operation !== 'initializeReader' && frame.sessionId === null) throw new ReaderHostError('DENIED');
  // Account/Profile/organization are host-bound, never writable transport fields.
  if (Object.keys(frame.payload).some(key => /account|profile|organi[sz]ation|token|secret|key|path/i.test(key))) {
    throw new ReaderHostError('DENIED');
  }
  const payloadKeys: Record<Operation, string[]> = {
    initializeReader: ['readerBuild'], loadReadingState: [], closeReader: [],
    saveProgress: ['operationId', 'expectedRevision', 'locator'],
    upsertAnnotation: ['operationId', 'expectedRevision', 'annotation'],
    deleteAnnotation: ['operationId', 'expectedRevision', 'annotation'],
  };
  if (Object.keys(frame.payload).some(key => !payloadKeys[frame.operation as Operation].includes(key))) {
    throw new ReaderHostError('DENIED');
  }
  return frame as ControlFrame;
}

export function validateContext(value: unknown): ReaderContext {
  if (!ownRecord(value) || value.protocol !== READER_PROTOCOL || value.readerBuild !== READER_BUILD
    || !validId(value.sessionId) || !positiveEpoch(value.epoch) || value.epoch === 0
    || !validId(value.presentationId) || !validId(value.buildId)
    || value.mode !== 'local-unencrypted'
    || !Array.isArray(value.resources) || value.resources.length === 0 || value.resources.length > LIMITS.resources
    || !ownRecord(value.permissions)) {
    throw new ReaderHostError('INVALID_MESSAGE');
  }
  const permissions = value.permissions;
  if (Object.keys(value).some(key => !['protocol', 'readerBuild', 'sessionId', 'epoch', 'presentationId', 'buildId', 'mode', 'resources', 'permissions'].includes(key))
    || Object.keys(permissions).some(key => !['annotate', 'copy', 'print', 'export'].includes(key))
    || ['annotate', 'copy', 'print', 'export'].some(key => typeof permissions[key] !== 'boolean')
    || byteLength(JSON.stringify(value)) > LIMITS.manifestBytes) throw new ReaderHostError('LIMIT');
  const ids = new Set<string>();
  const paths = new Set<string>();
  let total = 0;
  for (const resource of value.resources) {
    if (!ownRecord(resource) || !validId(resource.id) || typeof resource.href !== 'string'
      || typeof resource.mediaType !== 'string' || resource.mediaType.length > 128
      || !positiveEpoch(resource.bytes) || resource.bytes > LIMITS.resourceBytes) throw new ReaderHostError('LIMIT');
    const path = canonicalResourcePath(resource.href);
    if (ids.has(resource.id) || paths.has(path)) throw new ReaderHostError('INVALID_MESSAGE');
    ids.add(resource.id); paths.add(path); total += resource.bytes;
  }
  if (total > LIMITS.publicationBytes) throw new ReaderHostError('LIMIT');
  // Clone the host reply so a transport cannot mutate authority mid-session.
  return structuredClone(value) as ReaderContext;
}

export function validateAnnotation(value: unknown): asserts value is Annotation {
  if (!ownRecord(value) || !validId(value.id) || !positiveEpoch(value.revision)
    || !['bookmark', 'highlight', 'note'].includes(value.kind as string) || typeof value.deleted !== 'boolean'
    || (value.note !== undefined && typeof value.note !== 'string')
    || Object.keys(value).some(key => !['id', 'revision', 'kind', 'locator', 'note', 'deleted'].includes(key))) {
    throw new ReaderHostError('INVALID_MESSAGE');
  }
  if (typeof value.note === 'string' && byteLength(value.note) > LIMITS.noteBytes) throw new ReaderHostError('LIMIT');
  validateLocator(value.locator);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ReaderHostError('STALE_SESSION'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

export class ReaderSession {
  #transport: HostTransport;
  #context: ReaderContext | null = null;
  #generation = 0;
  #pending = new Set<AbortController>();
  constructor(transport: HostTransport) { this.#transport = transport; }
  get context() { return this.#context === null ? null : structuredClone(this.#context); }
  invalidate() {
    this.#generation++;
    this.#context = null;
    for (const pending of this.#pending) pending.abort();
    this.#pending.clear();
  }
  async #request(operation: Operation, payload: Record<string, unknown>): Promise<unknown> {
    if (this.#pending.size >= LIMITS.pendingRequests) throw new ReaderHostError('LIMIT');
    const generation = this.#generation;
    const context = this.#context;
    if (operation !== 'initializeReader' && context === null) throw new ReaderHostError('STALE_SESSION');
    const frame = parseControlMessage({ protocol: READER_PROTOCOL, requestId: crypto.randomUUID(),
      sessionId: context?.sessionId ?? null, epoch: context?.epoch ?? 0, operation, payload });
    const controller = new AbortController();
    this.#pending.add(controller);
    const timer = setTimeout(() => controller.abort(), LIMITS.requestTimeoutMs);
    try {
      const reply = await abortable(this.#transport.control(frame, controller.signal), controller.signal);
      if (controller.signal.aborted || generation !== this.#generation) throw new ReaderHostError('STALE_SESSION');
      if (reply.protocol !== READER_PROTOCOL || reply.requestId !== frame.requestId
        || (operation !== 'initializeReader' && (reply.sessionId !== frame.sessionId || reply.epoch !== frame.epoch))) {
        throw new ReaderHostError('INVALID_MESSAGE');
      }
      if (!reply.ok) throw new ReaderHostError(errorCodes.has(reply.error as HostErrorCode) ? reply.error! : 'INVALID_MESSAGE');
      return reply.data;
    } catch (error) {
      if (controller.signal.aborted || generation !== this.#generation) throw new ReaderHostError('STALE_SESSION');
      if (error instanceof ReaderHostError) throw error;
      throw new ReaderHostError('UNAVAILABLE');
    } finally { clearTimeout(timer); this.#pending.delete(controller); }
  }
  async initialize() {
    this.invalidate();
    const generation = this.#generation;
    const data = await this.#request('initializeReader', { readerBuild: READER_BUILD });
    const context = validateContext(data);
    // #request and initialize have separate async continuations. Invalidation
    // can occur between them; the final check must immediately precede publish.
    if (generation !== this.#generation) throw new ReaderHostError('STALE_SESSION');
    this.#context = context;
    return this.context!;
  }
  async loadState(): Promise<ReadingState> {
    const data = await this.#request('loadReadingState', {});
    if (!ownRecord(data) || !positiveEpoch(data.revision) || !Array.isArray(data.annotations)
      || data.annotations.length > LIMITS.annotations || !positiveEpoch(data.unresolvedLegacyCount)) {
      throw new ReaderHostError('INVALID_MESSAGE');
    }
    if (data.locator !== null) validateLocator(data.locator);
    for (const annotation of data.annotations) validateAnnotation(annotation);
    if (byteLength(JSON.stringify(data)) > LIMITS.stateBytes) throw new ReaderHostError('LIMIT');
    return data as ReadingState;
  }
  async saveProgress(locator: Locator, expectedRevision: number, operationId = crypto.randomUUID()) {
    validateLocator(locator);
    if (!positiveEpoch(expectedRevision) || !validId(operationId)) throw new ReaderHostError('INVALID_MESSAGE');
    return this.#request('saveProgress', { operationId, expectedRevision, locator });
  }
  async saveAnnotation(annotation: Annotation, expectedRevision: number, operationId = crypto.randomUUID()) {
    validateAnnotation(annotation);
    if (!positiveEpoch(expectedRevision) || !validId(operationId)) throw new ReaderHostError('INVALID_MESSAGE');
    if (!this.#context?.permissions.annotate) throw new ReaderHostError('DENIED');
    return this.#request(annotation.deleted ? 'deleteAnnotation' : 'upsertAnnotation', {
      operationId, expectedRevision, annotation,
    });
  }
  async resource(href: string): Promise<ArrayBuffer> {
    const context = this.#context;
    const generation = this.#generation;
    if (context === null) throw new ReaderHostError('STALE_SESSION');
    const path = canonicalResourcePath(href);
    const resource = context.resources.find(item => canonicalResourcePath(item.href) === path);
    if (!resource) throw new ReaderHostError('DENIED');
    const expectedBytes = resource.bytes;
    // The adapter receives detached nested views, never private permissions or
    // manifest records. Its accidental/malicious mutations cannot change bounds.
    const transportContext = structuredClone(context);
    const transportResource = structuredClone(resource);
    if (this.#pending.size >= LIMITS.pendingRequests) throw new ReaderHostError('LIMIT');
    const controller = new AbortController();
    this.#pending.add(controller);
    const timer = setTimeout(() => controller.abort(), LIMITS.requestTimeoutMs);
    try {
      const bytes = await abortable(this.#transport.resource(transportContext, transportResource, controller.signal), controller.signal);
      if (generation !== this.#generation || controller.signal.aborted) throw new ReaderHostError('STALE_SESSION');
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== expectedBytes
        || bytes.byteLength > LIMITS.resourceBytes) throw new ReaderHostError('INTEGRITY');
      return bytes;
    } catch (error) {
      if (generation !== this.#generation || controller.signal.aborted) throw new ReaderHostError('STALE_SESSION');
      if (error instanceof ReaderHostError) throw error;
      throw new ReaderHostError('UNAVAILABLE');
    } finally { clearTimeout(timer); this.#pending.delete(controller); }
  }
  async close() {
    try { if (this.#context) await this.#request('closeReader', {}); }
    finally { this.invalidate(); }
  }
}
