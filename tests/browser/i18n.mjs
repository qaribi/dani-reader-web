import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';

const origin = 'http://127.0.0.1:4173';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', '4173'], { stdio: 'ignore' });
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(origin)).ok) break; } catch { /* Wait for preview. */ }
    if (attempt > 100) throw Error('Preview server did not start');
    await delay(100);
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined, args: process.env.PLAYWRIGHT_EXECUTABLE_PATH ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : [] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.locator('input[type=file]').setInputFiles('public/fixtures/original-fa.epub');
  await page.locator('.book-grid article button').first().click();
  const reader = page.locator('.reader-shell');
  await page.waitForFunction(() => document.querySelector('.reader-shell')?.dataset.readerReady === 'true');
  await page.getByRole('button', { name: 'صفحهٔ بعد', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.reader-shell')?.dataset.navigationPending === 'false');
  await page.locator('input[type=range]').first().fill('24');
  await page.locator('.reader-tools select').first().selectOption('scrolled');
  await page.locator('.reader-tools select').last().selectOption('sepia');
  await page.locator('aside details').last().locator('summary').click();
  const note = page.locator('textarea');
  await note.fill('یادداشت آزمایشی Latin 123');
  await page.getByRole('button', { name: 'ذخیرهٔ یادداشت', exact: true }).click();
  await page.locator('.annotation').waitFor();
  await note.fill('پیش‌نویس ذخیره‌نشده Draft');
  // Let debounced progress and accepted saves settle before comparing persisted state.
  await page.waitForFunction(() => !document.querySelector('header [role=status]')?.textContent.includes('ذخیره'));
  const snapshot = () => page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('dani-reader-web-local-v1');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const read = (store, key) => new Promise((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const id = document.querySelector('.reader-shell').dataset.bookId;
    const result = { state: (await read('states', id)).state, settings: await read('settings', 'reading') };
    db.close(); return result;
  });
  await delay(800); // Flush the reader's 500ms progress debounce after layout changes.
  // A saved note guarantees a state record; wait for current CFI to be persisted too.
  await page.waitForFunction(async () => {
    const root = document.querySelector('.reader-shell');
    const db = await new Promise(resolve => { const r = indexedDB.open('dani-reader-web-local-v1'); r.onsuccess = () => resolve(r.result); });
    const state = await new Promise(resolve => { const r = db.transaction('states').objectStore('states').get(root.dataset.bookId); r.onsuccess = () => resolve(r.result?.state); });
    db.close(); return typeof state?.locator?.value === 'string' && state.locator.value === root.dataset.readingCfi && state?.annotations.length === 1;
  });
  const before = await snapshot();
  assert.equal(before.settings.fontSize, 24);
  assert.equal(before.settings.theme, 'sepia');
  assert.equal(before.settings.flow, 'scrolled');
  await page.evaluate(() => { window.originalReader = document.querySelector('dani-epub-view'); });
  const cfi = await reader.getAttribute('data-reading-cfi');
  for (const locale of ['ar', 'prs', 'ps', 'ur', 'fa']) {
    await page.locator('.language-picker select').selectOption(locale);
    await page.waitForFunction(code => document.documentElement.lang === code, locale);
    assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
    assert.equal(await reader.getAttribute('data-book-language'), 'fa');
    assert.equal(await page.evaluate(() => window.originalReader === document.querySelector('dani-epub-view')), true);
    assert.equal(await reader.getAttribute('data-reading-cfi'), cfi);
    assert.equal(await note.inputValue(), 'پیش‌نویس ذخیره‌نشده Draft');
    const current = await snapshot();
    assert.deepEqual(current.settings, before.settings);
    assert.deepEqual(current.state.annotations, before.state.annotations);
    assert.deepEqual(current.state.locator, before.state.locator);
  }
  await page.locator('.language-picker select').selectOption('ur');
  await page.waitForFunction(() => document.documentElement.lang === 'ur');
  await page.reload();
  await page.waitForFunction(() => document.documentElement.lang === 'ur');
  await page.locator('.book-grid article button').first().click();
  await page.waitForFunction(() => document.querySelector('.reader-shell')?.dataset.readerReady === 'true');
  const restored = await snapshot();
  assert.deepEqual(restored.settings, before.settings);
  assert.deepEqual(restored.state.annotations, before.state.annotations);
  assert.deepEqual(restored.state.locator, before.state.locator);
  // Native review notice and actual translated controls are rendered.
  assert.equal(await page.locator('.language-picker small').count(), 1);
  assert.ok(await page.getByRole('button', { name: 'اگلا صفحہ', exact: true }).count());
  assert.deepEqual(errors, []);
  console.log('PASS: five UI locales preserve mounted reader, CFI, saved notes, drafts and settings; preference/restoration survives reload.');
} finally {
  await browser?.close(); server.kill();
}
