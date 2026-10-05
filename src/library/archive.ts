import { BlobReader, ZipReader } from '@zip.js/zip.js';
import { canonicalResourcePath, LIMITS, ReaderHostError } from '../reader/host-contract.ts';
import { localBookContext } from './local-transport.ts';

export const ARCHIVE_LIMITS = Object.freeze({ inputBytes: 32 * 1024 * 1024, entries: 512, ratio: 100 });
export type ImportedBook = {
  id: string; title: string; language: string; addedAt: number; inputBytes: number;
  resources: Record<string, ArrayBuffer>; mediaTypes: Record<string, string>; expandedBytes: number;
};
const decoder = new TextDecoder('utf-8', { fatal: true });
export const decodeXml = (bytes: ArrayBuffer): string => {
  let text: string;
  try { text = decoder.decode(bytes); } catch { throw new ReaderHostError('INTEGRITY'); }
  if (text.includes('\u0000') || /<!DOCTYPE|<!ENTITY/iu.test(text)) throw new ReaderHostError('DENIED');
  return text;
};

export function parseXml(bytes: ArrayBuffer): Document {
  const doc = new DOMParser().parseFromString(decodeXml(bytes), 'application/xml');
  if (doc.querySelector('parsererror') || !doc.documentElement) throw new ReaderHostError('INTEGRITY');
  const pending: [Element, number][] = [[doc.documentElement, 1]];
  let elements = 0;
  while (pending.length) {
    const [element, depth] = pending.pop()!;
    if (++elements > 50_000 || depth > 128) throw new ReaderHostError('LIMIT');
    for (const child of element.children) pending.push([child, depth + 1]);
  }
  return doc;
}

export function archiveReference(href: string, relativeTo: string): string {
  if (href.length > 1024 || /[\x00-\x1f\\]/u.test(href)) throw new ReaderHostError('DENIED');
  const resolved = new URL(href, 'https://archive.invalid/' + relativeTo);
  if (resolved.origin !== 'https://archive.invalid' || resolved.search || resolved.username || resolved.password) {
    throw new ReaderHostError('DENIED');
  }
  return canonicalResourcePath(resolved.pathname.slice(1));
}

export async function extractArchive(file: Blob, signal = new AbortController().signal): Promise<Record<string, ArrayBuffer>> {
  if (!file.size || file.size > ARCHIVE_LIMITS.inputBytes) throw new ReaderHostError('LIMIT');
  const reader = new ZipReader(new BlobReader(file), { useWebWorkers: false, useCompressionStream: true });
  const resources: Record<string, ArrayBuffer> = Object.create(null);
  const seen = new Set<string>();
  let count = 0, inflated = 0, declared = 0;
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      if (signal.aborted) throw new ReaderHostError('STALE_SESSION');
      if (++count > ARCHIVE_LIMITS.entries) throw new ReaderHostError('LIMIT');
      const path = canonicalResourcePath(entry.directory ? entry.filename.replace(/\/$/, '') : entry.filename);
      if (seen.has(path)) throw new ReaderHostError('INTEGRITY');
      seen.add(path);
      const unixType = ((entry.externalFileAttributes >>> 16) & 0xf000);
      if (entry.encrypted || (unixType !== 0 && unixType !== (entry.directory ? 0x4000 : 0x8000))) {
        throw new ReaderHostError('DENIED');
      }
      if (entry.directory) {
        if (entry.uncompressedSize || entry.compressedSize) throw new ReaderHostError('INTEGRITY');
        continue;
      }
      if (![0, 8].includes(entry.compressionMethod) || entry.uncompressedSize > LIMITS.resourceBytes
        || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
        || entry.uncompressedSize > Math.max(1, entry.compressedSize) * ARCHIVE_LIMITS.ratio) {
        throw new ReaderHostError('LIMIT');
      }
      declared += entry.uncompressedSize;
      if (declared > LIMITS.publicationBytes) throw new ReaderHostError('LIMIT');
      let size = 0;
      const chunks: Uint8Array[] = [];
      const writer = new WritableStream<Uint8Array>({ write(chunk) {
        size += chunk.byteLength;
        inflated += chunk.byteLength;
        if (size > LIMITS.resourceBytes || inflated > LIMITS.publicationBytes || size > entry.uncompressedSize) {
          throw new ReaderHostError('LIMIT');
        }
        chunks.push(chunk.slice());
      } });
      await entry.getData(writer, { signal, checkSignature: true, useWebWorkers: false });
      if (size !== entry.uncompressedSize) throw new ReaderHostError('INTEGRITY');
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      resources[path] = bytes.buffer;
    }
  } catch (error) {
    if (error instanceof ReaderHostError) throw error;
    throw new ReaderHostError(signal.aborted ? 'STALE_SESSION' : 'INTEGRITY');
  } finally { await reader.close(); }
  if (!resources.mimetype || decoder.decode(resources.mimetype) !== 'application/epub+zip'
    || !resources['META-INF/container.xml']) throw new ReaderHostError('INTEGRITY');
  if (resources['META-INF/encryption.xml']) throw new ReaderHostError('DENIED');
  return resources;
}

export async function importEpub(file: Blob, signal?: AbortSignal): Promise<ImportedBook> {
  const resources = await extractArchive(file, signal);
  const container = parseXml(resources['META-INF/container.xml']);
  const roots = container.getElementsByTagNameNS('urn:oasis:names:tc:opendocument:xmlns:container', 'rootfile');
  if (roots.length !== 1) throw new ReaderHostError('INTEGRITY');
  const packagePath = canonicalResourcePath(roots[0].getAttribute('full-path') ?? '');
  if (!resources[packagePath]) throw new ReaderHostError('INTEGRITY');
  const opf = parseXml(resources[packagePath]);
  if (opf.documentElement.namespaceURI !== 'http://www.idpf.org/2007/opf'
    || !/^3(?:\.|$)/.test(opf.documentElement.getAttribute('version') ?? '')) throw new ReaderHostError('DENIED');
  const items = Array.from(opf.getElementsByTagNameNS('http://www.idpf.org/2007/opf', 'item'));
  if (!items.length || !opf.getElementsByTagNameNS('http://www.idpf.org/2007/opf', 'itemref').length) throw new ReaderHostError('INTEGRITY');
  const mediaTypes: Record<string, string> = Object.create(null);
  for (const item of items) {
    const path = archiveReference(item.getAttribute('href') ?? '', packagePath);
    if (!resources[path]) throw new ReaderHostError('INTEGRITY');
    const type = item.getAttribute('media-type') ?? '';
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/iu.test(type) || mediaTypes[path]) throw new ReaderHostError('INTEGRITY');
    mediaTypes[path] = type;
    if (/javascript|ecmascript|text\/html/iu.test(type)) throw new ReaderHostError('DENIED');
    if (['application/xhtml+xml', 'image/svg+xml', 'application/xml'].includes(type)) parseXml(resources[path]);
  }
  for (const [path, bytes] of Object.entries(resources)) {
    if (/\.(?:xml|opf|ncx|xhtml|svg)$/iu.test(path)) decodeXml(bytes);
  }
  const title = opf.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0]?.textContent?.trim().slice(0, 256);
  const language = opf.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'language')[0]?.textContent?.trim().slice(0, 64);
  if (!title || !language) throw new ReaderHostError('INTEGRITY');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  const book: ImportedBook = { id: Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join(''), title, language,
    addedAt: Date.now(), inputBytes: file.size, resources, mediaTypes,
    expandedBytes: Object.values(resources).reduce((sum, bytes) => sum + bytes.byteLength, 0) };
  localBookContext(book); // Reject an unopenable resource manifest before saving it.
  return book;
}
