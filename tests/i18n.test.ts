import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogs, locales, translate, formatNumber, statusText, preferenceKey, loadLocale, persistLocale } from '../src/i18n/core.ts';
import { ReaderHostError } from '../src/reader/host-contract.ts';
import { readerErrorMessage } from '../src/reader/errors.ts';

test('versioned catalogs have complete keys, matching interpolation and explicit review queues', () => {
  const source = catalogs.fa.messages;
  for (const locale of locales) {
    const catalog = catalogs[locale];
    assert.equal(catalog.schemaVersion, 1);
    assert.match(catalog.catalogVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(catalog.locale, locale);
    assert.deepEqual(Object.keys(catalog.messages).sort(), Object.keys(source).sort());
    for (const key of Object.keys(source) as (keyof typeof source)[]) {
      assert.ok(catalog.messages[key].trim());
      assert.deepEqual(catalog.messages[key].match(/\{\w+\}/g), source[key].match(/\{\w+\}/g));
    }
    assert.equal(catalog.review.status, locale === 'fa' ? 'source' : 'needs-native-review');
    if (locale !== 'fa') assert.deepEqual(catalog.review.keys.sort(), Object.keys(source).sort());
  }
});
test('language preference is versioned, validates input and tolerates blocked storage', () => {
  const values = new Map<string, string>([['reading', 'unchanged'], ['notes', 'unchanged']]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  for (const locale of locales) { persistLocale(locale, storage); assert.equal(loadLocale(storage), locale); }
  assert.equal(values.get('reading'), 'unchanged'); assert.equal(values.get('notes'), 'unchanged');
  for (const value of ['oops', '{}', '{"version":2,"locale":"ur"}', '{"version":1,"locale":"en"}']) {
    values.set(preferenceKey, value); assert.equal(loadLocale(storage), 'fa');
  }
  assert.equal(loadLocale({ getItem() { throw Error('blocked'); } }), 'fa');
  assert.doesNotThrow(() => persistLocale('ur', { setItem() { throw Error('blocked'); } }));
});
test('numbers, mixed text and already-pending statuses follow the selected UI locale', () => {
  assert.equal(formatNumber('fa', 123), '۱۲۳'); assert.equal(formatNumber('ar', 123), '١٢٣');
  assert.match(translate('ur', 'readBook', { title: 'EPUB فارسی' }), /\u2068EPUB فارسی\u2069/);
  const status = 'saveFailed\u001ferrorSTORAGE';
  for (const locale of locales) {
    assert.equal(statusText(status, locale), translate(locale, 'saveFailed') + readerErrorMessage(new ReaderHostError('STORAGE'), locale));
    assert.equal(readerErrorMessage(new Error('private details'), locale), translate(locale, 'errorUNAVAILABLE'));
  }
});
