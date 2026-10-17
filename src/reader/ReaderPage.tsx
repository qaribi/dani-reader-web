import { useI18n, LanguagePicker } from '../i18n/react.tsx';
import { statusText } from '../i18n/core.ts';
import { useEffect, useRef, useState } from 'react';
import { ReaderSession, READER_BUILD, LIMITS, ReaderHostError } from './host-contract.ts';
import type { Annotation, Locator, ReaderContext, ReadingState } from './host-contract.ts';
import { LocalTransport } from '../library/local-transport.ts';
import type { ImportedBook } from '../library/archive.ts';
import type { LocalLibrary, ReadingSettings } from '../library/database.ts';
import { readerErrorKey } from './errors.ts';
import { readingLocator as locator } from './reading-location.ts';
import { openHostPublication } from './publication.ts';
import { ConsumerLifetime, clearPrivateWorkspace, retirePrivateWorkspace, emptyReading,
  loadAndPublishReading, publishReading, consumeSearchResults } from './consumer-lifetime.ts';
import type { ConsumerToken, PrivateWorkspaceSink } from './consumer-lifetime.ts';

type TocItem = { label: string; href: string; subitems?: TocItem[] };
type SearchMatch = { cfi: string; excerpt?: string | { pre: string; match: string; post: string } };
interface FoliateElement extends HTMLElement {
  open(book: unknown): Promise<void>;
  init(options: { lastLocation?: string; showTextStart?: boolean }): Promise<void>;
  close(): void;
  goTo(value: string | number): Promise<void>;
  prev(): Promise<void>;
  next(): Promise<void>;
  goLeft(): Promise<void>;
  goRight(): Promise<void>;
  getCFI(index: number, range: Range): string;
  addAnnotation(annotation: { value: string; color?: string }): Promise<unknown>;
  deleteAnnotation(annotation: { value: string }): Promise<unknown>;
  search(options: { query: string; matchCase: boolean; matchWholeWords: boolean }): AsyncIterable<SearchMatch | { subitems: SearchMatch[] } | { progress: number } | string>;
  clearSearch(): void;
  renderer: HTMLElement & {
    setStyles?(styles: string): void;
    getContents(): { index: number; doc: Document }[];
  };
}
type TocRow = { label: string; href: string };
type OwnedResources = { token: ConsumerToken; stop(disposeTransport?: boolean): void };
const safeError = readerErrorKey;
const tocEntries = (items: TocItem[], depth = 0): { label: string; href: string }[] =>
  depth > 16 ? [] : items.slice(0, 256).flatMap(item => [item, ...tocEntries(item.subitems ?? [], depth + 1)]).slice(0, 256);

export default function ReaderPage({ book: importedBook, library, settings, onSettings, onExit }: { book: ImportedBook; library: LocalLibrary; settings: ReadingSettings; onSettings(value: ReadingSettings): void; onExit(): void }) {
  const { t, locale, number, percent } = useI18n();
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<FoliateElement | null>(null);
  const session = useRef<ReaderSession | null>(null);
  const consumer = useRef(new ConsumerLifetime()).current;
  const resources = useRef<OwnedResources | null>(null);
  const stateRef = useRef<ReadingState>(emptyReading());
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const selection = useRef<Locator | null>(null);
  const [context, setContext] = useState<ReaderContext | null>(null);
  const [reading, setReading] = useState<ReadingState>(emptyReading);
  const [status, setStatus] = useState('openingBook');
  const [toc, setToc] = useState<TocRow[]>([]);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [note, setNote] = useState('');
  const [navigating, setNavigating] = useState(false);
  const [fixedLayout, setFixedLayout] = useState(false);
  const [saving, setSaving] = useState(false);
  const acceptedSaves = useRef(0);
  const fontSize = settings.fontSize;
  const setFontSize = (fontSize: number) => onSettings({ ...settings, fontSize });
  const flow = settings.flow;
  const setFlow = (flow: ReadingSettings['flow']) => onSettings({ ...settings, flow });

  const sink: PrivateWorkspaceSink<SearchMatch, TocRow> = {
    readingRef: stateRef, setReading, setMatches, setToc, setNote, setQuery, setContext, setStatus,
    clearRefs: () => {
      session.current = null; view.current = null; selection.current = null;
      resources.current = null; saveChain.current = Promise.resolve();
    },
  };
  const enqueueSave = (write: (host: ReaderSession, current: ReadingState) => Promise<unknown>,
    token = consumer.current) => {
    const host = session.current;
    if (!token || !consumer.isCurrent(token) || !host?.context) return;
    acceptedSaves.current++;
    consumer.publish(token, () => setSaving(true));
    const pending = saveChain.current.then(async () => {
      if (!consumer.isCurrent(token) || session.current !== host || !host.context) return;
      await write(host, stateRef.current);
      if (!consumer.isCurrent(token) || session.current !== host || !host.context) return;
      await loadAndPublishReading(consumer, token, sink, () => host.loadState());
    }).catch(error => {
      consumer.publish(token, () => setStatus('saveFailed\u001f' + safeError(error)));
    }).finally(() => {
      acceptedSaves.current--;
      consumer.publish(token, () => setSaving(acceptedSaves.current > 0));
    });
    consumer.publish(token, () => { saveChain.current = pending; });
  };

  useEffect(() => {
    const token = consumer.begin();
    clearPrivateWorkspace(consumer, token, sink, 'openingBook');
    let element: FoliateElement | null = null;
    let host: ReaderSession | null = null;
    let transport: LocalTransport | null = null;
    let book: { destroy?: () => void } | null = null;
    const lifetime = new AbortController();
    let progressTimer: ReturnType<typeof setTimeout> | undefined;
    // Local handles belong to this token, never to a later mounted consumer.
    const owned: OwnedResources = { token, stop: (disposeTransport = true) => {
      if (progressTimer) clearTimeout(progressTimer);
      try { element?.close(); } catch { /* Removal must still retire the realm UI. */ }
      element?.remove();
      try { book?.destroy?.(); } finally {
        if (disposeTransport) { lifetime.abort(); transport?.dispose(); }
      }
    } };
    consumer.publish(token, () => { resources.current = owned; });
    const initialize = async () => {
      const assertActive = () => {
        if (!consumer.isCurrent(token) || !host?.context) throw new ReaderHostError('STALE_SESSION');
      };
      transport = new LocalTransport(importedBook, library);
      if (!consumer.isCurrent(token)) { transport.dispose(); return; }
      host = new ReaderSession(transport);
      consumer.publish(token, () => { session.current = host; });
      const active = await host.initialize();
      assertActive();
      await loadAndPublishReading(consumer, token, sink, () => host!.loadState());
      assertActive();
      const saved = stateRef.current;
      await import('./foliate-epub-view.js');
      assertActive();
      const publication = await openHostPublication(host);
      book = publication;
      consumer.publish(token, () => setFixedLayout(publication.rendition?.layout === 'pre-paginated'));
      assertActive();
      element = document.createElement('dani-epub-view') as FoliateElement;
      element.setAttribute('aria-label', 'EPUB');
      element.setAttribute('tabindex', '0');
      consumer.publish(token, () => mount.current?.append(element!), () => { view.current = element; });
      element.addEventListener('relocate', (event: Event) => {
        const detail = (event as CustomEvent).detail;
        if (!consumer.isCurrent(token) || !host?.context || view.current !== element || typeof detail.cfi !== 'string') return;
        const location = locator(detail.cfi, detail.fraction);
        publishReading(consumer, token, sink, { ...stateRef.current, locator: location });
        if (progressTimer) clearTimeout(progressTimer);
        progressTimer = setTimeout(() => {
          enqueueSave((activeHost, current) => activeHost.saveProgress(location, current.revision), token);
        }, 500);
      });
      element.addEventListener('load', (event: Event) => {
        if (!consumer.isCurrent(token) || view.current !== element) return;
        const { doc, index } = (event as CustomEvent).detail as { doc: Document; index: number };
        doc.addEventListener('selectionchange', () => {
          const selected = doc.defaultView?.getSelection();
          if (!selected || selected.isCollapsed || selected.rangeCount === 0 || !element || !consumer.isCurrent(token)) return;
          const anchor = locator(element.getCFI(index, selected.getRangeAt(0)));
          consumer.publish(token, () => { selection.current = anchor; });
        });
        if (!active.permissions.copy) doc.addEventListener('copy', event => event.preventDefault());
        doc.addEventListener('keydown', event => {
          if (!consumer.isCurrent(token) || view.current !== element) return;
          if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
          const target = event.target as Element | null;
          if (target?.closest('input,textarea,select,[contenteditable]')) return;
          if (event.key === 'ArrowLeft') { event.preventDefault(); void element?.goLeft(); }
          if (event.key === 'ArrowRight') { event.preventDefault(); void element?.goRight(); }
        });
        // External links cannot launch a popup/top navigation; the native host
        // owner may later bind a user-click allowlisted link operation.
        doc.addEventListener('click', event => {
          const target = event.target as Element | null;
          const href = target?.closest('a')?.getAttribute('href');
          if (href && /^(?:[a-z]+:|\/\/)/i.test(href) && !href.startsWith('blob:')) event.preventDefault();
        }, true);
      });
      const { Overlayer } = await import('foliate-js/overlayer.js');
      assertActive();
      element.addEventListener('draw-annotation', (event: Event) => {
        const { draw } = (event as CustomEvent).detail;
        consumer.publish(token, () => draw(Overlayer.highlight, { color: '#f7dc75' }));
      });
      element.addEventListener('create-overlay', () => {
        // The engine emits before assigning the new overlayer; resume after it.
        void Promise.resolve().then(async () => {
          if (!consumer.isCurrent(token) || view.current !== element) return;
          for (const annotation of stateRef.current.annotations.filter(item => !item.deleted && item.kind !== 'bookmark')) {
            if (!consumer.isCurrent(token) || view.current !== element) return;
            await element!.addAnnotation({ value: annotation.locator.value });
          }
        }).catch(() => { consumer.publish(token, () => setStatus('overlayFailed\u001f')); });
      });
      await element.open(publication);
      assertActive();
      element.renderer.setStyles?.(`html,body { font-size:20px !important; line-height:1.8 !important; }`);
      await element.init(saved.locator ? { lastLocation: saved.locator.value } : { showTextStart: true });
      assertActive();
      for (const annotation of saved.annotations.filter(item => !item.deleted && item.kind !== 'bookmark')) {
        await element.addAnnotation({ value: annotation.locator.value });
        assertActive();
      }
      consumer.publish(token, () => setToc(tocEntries(publication.toc ?? [])), () => setContext(active),
        () => setStatus('ready'));
    };
    initialize().catch(error => {
      retirePrivateWorkspace(consumer, token, sink, 'openFailed\u001f' + safeError(error));
      host?.invalidate(); owned.stop();
    });
    return () => {
      retirePrivateWorkspace(consumer, token, sink, 'closed');
      host?.invalidate(); owned.stop();
    };
  }, [importedBook.id, library]);

  useEffect(() => { view.current?.setAttribute('aria-label', t('bookText')); }, [locale, context]);

  useEffect(() => {
    const token = consumer.current;
    const renderer = view.current?.renderer;
    if (!token || !renderer) return;
    consumer.publish(token, () => renderer.setAttribute('flow', flow),
      () => renderer.setStyles?.(`html,body { font-size:${fontSize}px !important; line-height:${settings.lineHeight} !important; color:${settings.theme === 'dark' ? '#eee' : '#222'} !important; background:${settings.theme === 'dark' ? '#20242a' : settings.theme === 'sepia' ? '#f4ecd8' : '#fff'} !important; }`));
  }, [fontSize, flow, settings.lineHeight, settings.theme, context]);

  const addAnnotation = (kind: Annotation['kind']) => {
    const token = consumer.current;
    const currentView = view.current;
    if (!token || !session.current?.context || !currentView) return;
    const anchor = kind === 'bookmark' ? stateRef.current.locator : selection.current ?? (kind === 'note' ? stateRef.current.locator : null);
    if (!anchor) { consumer.publish(token, () => setStatus('selectAnchor')); return; }
    const annotation: Annotation = { id: crypto.randomUUID(), revision: 0, kind,
      locator: anchor, deleted: false, ...(kind === 'note' ? { note } : {}) };
    enqueueSave(async (host, current) => {
      await host.saveAnnotation(annotation, current.revision);
      if (kind === 'note') consumer.publish(token, () => setNote(draft => draft === annotation.note ? '' : draft));
      if (consumer.isCurrent(token) && session.current === host && view.current === currentView && kind !== 'bookmark')
        await currentView.addAnnotation({ value: anchor.value });
    }, token);
  };
  const navigate = async (action: () => Promise<void> | undefined) => {
    const token = consumer.current;
    if (!token || navigating || !session.current?.context) return;
    consumer.publish(token, () => setNavigating(true), () => setStatus('navigating'));
    try { await action(); consumer.publish(token, () => setStatus('ready')); }
    catch (error) { consumer.publish(token, () => setStatus('navigationFailed\u001f' + safeError(error))); }
    finally { consumer.publish(token, () => setNavigating(false)); }
  };
  const search = async () => {
    const token = consumer.current;
    if (!token || !session.current?.context || !view.current || !query || query.length > LIMITS.searchChars) return;
    const current = view.current;
    consumer.publish(token, () => setMatches([]));
    try {
      await consumeSearchResults(consumer, token, sink, current.search({ query, matchCase: false, matchWholeWords: false }));
    } catch (error) { consumer.publish(token, () => setStatus('searchFailed\u001f' + safeError(error))); }
  };
  const exit = async () => {
    const token = consumer.current;
    if (!token || acceptedSaves.current > 0 || navigating) return;
    const host = session.current;
    const lastLocation = stateRef.current.locator;
    const pending = saveChain.current;
    const owned = resources.current?.token === token ? resources.current : null;
    // No await before retirement. A queued save/load/search cannot republish.
    retirePrivateWorkspace(consumer, token, sink, 'closed');
    owned?.stop(false);
    try { await pending; if (lastLocation && host?.context) { const current = await host.loadState(); await host.saveProgress(lastLocation, current.revision); } await host?.close(); }
    catch { /* A retired consumer must not publish a late close error. */ }
    finally { host?.invalidate(); owned?.stop(); onExit(); }
  };
  const deleteAnnotation = (item: Annotation) => {
    enqueueSave(async (host, current) => {
      await host.saveAnnotation({ ...item, deleted: true }, current.revision);
      const another = current.annotations.some(other => other.id !== item.id && !other.deleted
        && other.kind !== 'bookmark' && other.locator.value === item.locator.value);
      if (!another && item.kind !== 'bookmark') await view.current?.deleteAnnotation({ value: item.locator.value });
    });
  };
  const editPrivateText = (setValue: (value: string) => void, value: string) => {
    const token = consumer.current;
    if (token && session.current?.context) consumer.publish(token, () => setValue(value));
  };

  return <main className="reader-shell" data-book-id={importedBook.id} data-book-language={importedBook.language} data-reading-cfi={reading.locator?.value} data-reader-ready={Boolean(context)} data-navigation-pending={navigating}>
    <header><strong dir="auto">{importedBook.title}</strong><LanguagePicker /><span role="status">{saving ? t('saving') : statusText(status, locale)}</span><button disabled={saving || navigating} onClick={exit}>{t('exit')}</button></header>
    <section className="reader-tools" aria-label={t('settings')}>
      <button disabled={!context || navigating} onClick={() => { void navigate(() => view.current?.prev()); }}>{t('previous')}</button>
      <button disabled={!context || navigating} onClick={() => { void navigate(() => view.current?.next()); }}>{t('next')}</button>
      <label>{t('fontSize')} <input disabled={fixedLayout} aria-label={t('fontSize')} type="range" min="14" max="40" value={fontSize} onChange={event => setFontSize(Number(event.target.value))} /></label>
      <label>{t('flow')} <select value={flow} onChange={event => setFlow(event.target.value as typeof flow)}><option value="paginated">{t('paginated')}</option><option value="scrolled">{t('scrolled')}</option></select></label>
      <label>{t('lineHeight')} <input disabled={fixedLayout} aria-label={t('lineHeight')} type="range" min="1.2" max="3" step="0.1" value={settings.lineHeight} onChange={event => onSettings({ ...settings, lineHeight: Number(event.target.value) })} /></label>
      <label>{t('color')} <select disabled={fixedLayout} aria-label={t('theme')} value={settings.theme} onChange={event => onSettings({ ...settings, theme: event.target.value as ReadingSettings['theme'] })}><option value="light">{t('light')}</option><option value="sepia">{t('sepia')}</option><option value="dark">{t('dark')}</option></select></label>
      {fixedLayout && <small>{t('fixedLayout')}</small>}
      <button disabled={!context?.permissions.annotate} onClick={() => addAnnotation('bookmark')}>{t('bookmark')}</button>
      <button disabled={!context?.permissions.annotate} onClick={() => addAnnotation('highlight')}>{t('highlight')}</button>
    </section>
    <div className="reader-body">
      <aside aria-label={t('sidebar')}>
        <details open><summary>{t('toc')}</summary>{toc.map((item, index) => <button disabled={navigating} key={index} onClick={() => { void navigate(() => view.current?.goTo(item.href)); }}><bdi>{item.label}</bdi></button>)}</details>
        <details><summary>{t('search')}</summary><form onSubmit={event => { event.preventDefault(); void search(); }}><input dir="auto" aria-label={t('searchQuery')} disabled={!context} maxLength={LIMITS.searchChars} value={query} onChange={event => editPrivateText(setQuery, event.target.value)} /><button type="submit" disabled={!context}>{t('find')}</button></form>{matches.map((match, index) => <button dir="auto" key={index} onClick={() => view.current?.goTo(match.cfi)}>{typeof match.excerpt === 'string' ? match.excerpt : match.excerpt ? match.excerpt.pre + match.excerpt.match + match.excerpt.post : number(index + 1)}</button>)}</details>
        <details><summary>{t('notes')}</summary><textarea dir="auto" aria-label={t('noteInput')} disabled={!context?.permissions.annotate} maxLength={2048} value={note} onChange={event => editPrivateText(setNote, event.target.value)} /><button disabled={!context?.permissions.annotate} onClick={() => addAnnotation('note')}>{t('saveNote')}</button>{reading.unresolvedLegacyCount > 0 && <p>{t('legacyNotes', { count: number(reading.unresolvedLegacyCount) })}</p>}{reading.annotations.filter(item => !item.deleted).map(item => <div className="annotation" key={item.id}><button onClick={() => view.current?.goTo(item.locator.value)}>{item.note || (item.kind === 'bookmark' ? t('bookmark') : t('highlighted'))}</button><button disabled={saving} onClick={() => deleteAnnotation(item)}>{t('delete')}</button></div>)}</details>
      </aside>
      <div className="publication" ref={mount} />
    </div>
    <footer><span>{reading.locator?.progression === undefined ? '—' : percent(reading.locator.progression)}</span><a href="https://github.com/qaribi/dani-reader-web">{t('source')}</a><small>{t('credits')} · <bdi>{READER_BUILD}</bdi></small></footer>
  </main>;
}
