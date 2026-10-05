import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js';
import { extractArchive, decodeXml, archiveReference } from '../src/library/archive.ts';
import { ReaderHostError } from '../src/reader/host-contract.ts';

async function zip(entries: [string, string | Uint8Array][]) {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  for (const [path, value] of entries) await writer.add(path, new BlobReader(new Blob([value])), { level: 0 });
  return writer.close();
}
const minimum: [string, string][] = [['mimetype', 'application/epub+zip'], ['META-INF/container.xml', '<container/>']];
const rejects = (code: string) => (error: unknown) => error instanceof ReaderHostError && error.code === code;

test('bounded ZIP reader extracts real original five-language fixture bytes', async () => {
  for (const language of ['fa', 'ar', 'prs', 'ps', 'ur']) {
    const file = await readFile(new URL('../public/fixtures/original-' + language + '.epub', import.meta.url));
    const archive = await extractArchive(new Blob([file]));
    assert.equal(new TextDecoder().decode(archive.mimetype), 'application/epub+zip');
    assert.ok(new TextDecoder().decode(archive['EPUB/chapter1.xhtml']).includes('dir="rtl"'));
  }
});
test('ZIP traversal and duplicate normalized names are rejected before use', async () => {
  await assert.rejects(extractArchive(await zip([...minimum, ['../chapter.xhtml', 'text']])), rejects('DENIED'));
  await assert.rejects(extractArchive(await zip([...minimum, ['a%2Eb', 'one'], ['a.b', 'two']])), rejects('INTEGRITY'));
});
test('encrypted publication marker is rejected, including an empty encryption document', async () => {
  await assert.rejects(extractArchive(await zip([...minimum, ['META-INF/encryption.xml', '']])), rejects('DENIED'));
});
test('oversized entry is refused at declared bounds', async () => {
  await assert.rejects(extractArchive(await zip([...minimum, ['large.bin', new Uint8Array(2_097_153)]])), rejects('LIMIT'));
});
test('pre-aborted import does not admit archive bytes', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(extractArchive(await zip(minimum), controller.signal), rejects('STALE_SESSION'));
});
test('XML rejects DTD/entity and invalid UTF-8 without echoing payload', () => {
  for (const text of ['<!DOCTYPE x><x/>', '<!ENTITY x "private"><x/>']) {
    assert.throws(() => decodeXml(new TextEncoder().encode(text).buffer), rejects('DENIED'));
  }
  assert.throws(() => decodeXml(new Uint8Array([0xff]).buffer), rejects('INTEGRITY'));
  assert.throws(() => decodeXml(new Uint8Array([60, 0, 120, 0, 47, 0, 62, 0]).buffer), rejects('DENIED'));
});
test('internal parent/percent links resolve within archive; schemes cannot escape', () => {
  assert.equal(archiveReference('../chapter%201.xhtml#part', 'EPUB/nav/toc.xhtml'), 'EPUB/chapter 1.xhtml');
  for (const href of ['https://example.invalid/book', 'file:///book', '//example.invalid/book', 'javascript:alert(1)', '../a?key=1', '%252e%252e/file']) {
    assert.throws(() => archiveReference(href, 'EPUB/chapter.xhtml'), rejects('DENIED'));
  }
});
