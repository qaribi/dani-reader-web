import { useI18n, LanguagePicker } from './i18n/react.tsx';
import { statusText } from './i18n/core.ts';
import { useEffect, useState } from 'react';
import ReaderPage from './reader/ReaderPage.tsx';
import { importEpub } from './library/archive.ts';
import type { ImportedBook } from './library/archive.ts';
import { LocalLibrary, defaultSettings } from './library/database.ts';
import type { ReadingSettings } from './library/database.ts';
import { readerErrorKey } from './reader/errors.ts';

const library = new LocalLibrary();
const errorMessage = readerErrorKey;
export default function App() {
  const { t, locale, number } = useI18n();
  const [books, setBooks] = useState<ImportedBook[]>([]);
  const [active, setActive] = useState<ImportedBook | null>(null);
  const [settings, setSettings] = useState<ReadingSettings>(defaultSettings);
  const [status, setStatus] = useState('openingLibrary');
  const [busy, setBusy] = useState(false);
  const refresh = async () => setBooks((await library.list()).sort((a, b) => b.addedAt - a.addedAt));
  useEffect(() => { Promise.all([refresh(), library.settings().then(setSettings)]).then(() => setStatus('libraryReady')).catch(error => setStatus(errorMessage(error))); }, []);
  const add = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy(true); setStatus('checking');
    try { const book = await importEpub(file); await library.put(book); await refresh(); setStatus('added'); }
    catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const changeSettings = (next: ReadingSettings) => {
    setSettings(next);
    void library.saveSettings(next).catch(error => setStatus(errorMessage(error)));
  };
  if (active) return <ReaderPage key={active.id} book={active} library={library} settings={settings} onSettings={changeSettings} onExit={() => setActive(null)} />;
  return <main className="library-shell">
    <header><LanguagePicker /><div><h1>{t('libraryTitle')}</h1><p>{t('libraryDescription')}</p></div><span className="version">{t('version', { version: '0.1.0' })}</span></header>
    <section className="import-panel"><h2>{t('addBook')}</h2><p>{t('importHelp')}</p><label className="file-button">{t('chooseEpub')}<input aria-label={t('addEpub')} type="file" accept=".epub,application/epub+zip" disabled={busy} onChange={event => { void add(event.target.files?.[0]); event.target.value = ''; }} /></label><p role="status">{statusText(status, locale)}</p></section>
    <section aria-label={t('booksLabel')}><h2>{t('myBooks', { count: number(books.length) })}</h2>{!books.length && <p>{t('emptyLibrary')}</p>}<div className="book-grid">{books.map(book => <article key={book.id}>
      <h3 dir="auto">{book.title}</h3><p><bdi>{book.language}</bdi> · <bdi dir="ltr">{number(book.inputBytes / 1024, { maximumFractionDigits: 1 })} KB</bdi></p>
      <button aria-label={t('readBook', { title: book.title })} onClick={() => setActive(book)}>{t('read')}</button>
      <details><summary>{t('manage')}</summary><button className="danger" onClick={() => { void library.remove(book.id).then(refresh).then(() => setStatus('removed')).catch(error => setStatus(errorMessage(error))); }}>{t('removeBook')}</button></details>
    </article>)}</div></section>
    <footer>{t('credits')} · <a href="https://github.com/qaribi/dani-reader-web">{t('source')}</a></footer>
  </main>;
}
