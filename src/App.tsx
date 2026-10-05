import { useEffect, useState } from 'react';
import ReaderPage from './reader/ReaderPage.tsx';
import { importEpub } from './library/archive.ts';
import type { ImportedBook } from './library/archive.ts';
import { LocalLibrary, defaultSettings } from './library/database.ts';
import type { ReadingSettings } from './library/database.ts';
import { readerErrorMessage } from './reader/errors.ts';

const library = new LocalLibrary();
const errorMessage = (error: unknown) => readerErrorMessage(error);
export default function App() {
  const [books, setBooks] = useState<ImportedBook[]>([]);
  const [active, setActive] = useState<ImportedBook | null>(null);
  const [settings, setSettings] = useState<ReadingSettings>(defaultSettings);
  const [status, setStatus] = useState('در حال بازکردن کتابخانه…');
  const [busy, setBusy] = useState(false);
  const refresh = async () => setBooks((await library.list()).sort((a, b) => b.addedAt - a.addedAt));
  useEffect(() => { Promise.all([refresh(), library.settings().then(setSettings)]).then(() => setStatus('کتابخانهٔ محلی آماده است.')).catch(error => setStatus(errorMessage(error))); }, []);
  const add = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy(true); setStatus('در حال بررسی EPUB…');
    try { const book = await importEpub(file); await library.put(book); await refresh(); setStatus('کتاب به کتابخانه افزوده شد.'); }
    catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const changeSettings = (next: ReadingSettings) => {
    setSettings(next);
    void library.saveSettings(next).catch(error => setStatus(errorMessage(error)));
  };
  if (active) return <ReaderPage key={active.id} book={active} library={library} settings={settings} onSettings={changeSettings} onExit={() => setActive(null)} />;
  return <main className="library-shell">
    <header><div><h1>کتابخانهٔ دانی · DANI Reader</h1><p>کتاب‌های EPUB 3 محلی، بدون بارگذاری کتاب روی سرور</p></div><span className="version">نسخهٔ ۰.۱.۰</span></header>
    <section className="import-panel"><h2>افزودن کتاب</h2><p>EPUB بدون رمزگذاری، حداکثر ۳۲ مگابایت. کتاب و یادداشت‌ها در همین مرورگر نگهداری می‌شوند.</p><label className="file-button">انتخاب EPUB<input aria-label="افزودن EPUB" type="file" accept=".epub,application/epub+zip" disabled={busy} onChange={event => { void add(event.target.files?.[0]); event.target.value = ''; }} /></label><p role="status">{status}</p></section>
    <section aria-label="کتاب‌های کتابخانه"><h2>کتاب‌های من ({books.length})</h2>{!books.length && <p>برای شروع یک کتاب محلی اضافه کنید. پاک‌کردن دادهٔ مرورگر، کتابخانه و یادداشت‌ها را پاک می‌کند.</p>}<div className="book-grid">{books.map(book => <article key={book.id}>
      <h3 dir="auto">{book.title}</h3><p><bdi>{book.language}</bdi> · {(book.inputBytes / 1024).toFixed(1)} KB</p>
      <button aria-label={'مطالعه ' + book.title} onClick={() => setActive(book)}>مطالعه</button>
      <details><summary>مدیریت کتاب</summary><button className="danger" onClick={() => { void library.remove(book.id).then(refresh).then(() => setStatus('کتاب و یادداشت‌های مربوط به آن از کتابخانه حذف شدند.')).catch(error => setStatus(errorMessage(error))); }}>حذف کتاب و یادداشت‌های آن</button></details>
    </article>)}</div></section>
    <footer>EPUB reading core adapted from DANI / Readest · Local-only storage · <a href="https://github.com/qaribi/dani-reader-web">Source / کد · AGPL-3.0-or-later</a></footer>
  </main>;
}
