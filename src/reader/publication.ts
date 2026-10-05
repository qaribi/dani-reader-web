import { ReaderHostError, LIMITS, canonicalResourcePath } from './host-contract.ts';
import type { ReaderSession } from './host-contract.ts';

// Local loader provenance guard, not a rights/Identity/DRM grant. The host's
// ReaderSession resource interface independently binds every byte to its scope.
const hostPublications = new WeakSet<object>();
export const isHostPublication = (book: unknown): boolean =>
  book !== null && typeof book === 'object' && hostPublications.has(book);

// CSP applies before publication DOM is attached. Chromium (Windows WebView2
// and Android WebView) is the initial accepted-host candidate. Engine iframes
// additionally have allow-scripts removed by the recorded Dani foliate patch.
const PUBLICATION_CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; "
  + "img-src blob: data:; media-src blob:; font-src blob: data:; style-src 'unsafe-inline' blob:; "
  + "frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

// Deliberately reject escaped CSS constructs. This bounded reader accepts local
// publication styles, without interpreting obfuscated network or executable URLs.
export function sanitizePublicationCss(text: string): string {
  if (text.includes('\\') || /expression\s*\(|-moz-binding/iu.test(text)) return '';
  return text.replace(/@import\s+(?:url\([^)]*\)|[^;]*);?/giu, '')
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/giu, (all, _quote: string, url: string) =>
      /^(?:blob:|data:image\/(?:png|jpeg|gif|webp);base64,)/iu.test(url.trim()) ? all : 'none');
}

export function sanitizePublicationMarkup(text: string, type: string): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new ReaderHostError('DENIED');
  const isSvg = type === 'image/svg+xml';
  const isXhtml = type === 'application/xhtml+xml';
  const doc = new DOMParser().parseFromString(text, isSvg ? 'image/svg+xml' : isXhtml ? 'application/xhtml+xml' : 'text/html');
  if (doc.querySelector('parsererror')) throw new ReaderHostError('INTEGRITY');
  for (const element of Array.from(doc.querySelectorAll('script, iframe, object, embed, form, base, meta, input, button, foreignObject, animate, animateMotion, animateTransform, set'))) {
    if (element.localName === 'meta' && element.getAttribute('name') === 'viewport') {
      const values = (element.getAttribute('content') ?? '').split(',').map(part => part.trim().match(/^(width|height)\s*=\s*(\d{1,4})$/u));
      if (values.length === 2 && values.every(value => value && Number(value[2]) > 0 && Number(value[2]) <= 4096)
        && new Set(values.map(value => value![1])).size === 2) continue;
    }
    element.remove();
  }
  for (const element of Array.from(doc.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      const urlAttribute = /^(?:href|src|xlink:href|poster|background)$/i.test(attribute.name);
      const rasterData = /^data:image\/(?:png|jpeg|gif|webp);base64,/iu.test(attribute.value);
      const blobUrl = /^blob:/iu.test(attribute.value);
      const internalAnchor = element.localName === 'a' && attribute.name === 'href'
        && !/^[a-z][a-z0-9+.-]*:|^\/\//iu.test(attribute.value);
      const fragment = attribute.value.startsWith('#');
      if (/^on/i.test(attribute.name) || /^(?:action|formaction|srcdoc|srcset|target|ping)$/i.test(attribute.name)
        || (urlAttribute && (/[\x00-\x20\\]/u.test(attribute.value)
          || !(blobUrl || fragment || internalAnchor || (attribute.name === 'src' && rasterData))))) {
        element.removeAttribute(attribute.name);
      }
      if (attribute.name.toLowerCase() === 'style') element.setAttribute('style', sanitizePublicationCss(attribute.value));
    }
    if (element.localName === 'style') element.textContent = sanitizePublicationCss(element.textContent ?? '');
  }
  if (!isSvg) {
    const htmlNamespace = 'http://www.w3.org/1999/xhtml';
    const csp = isXhtml ? doc.createElementNS(htmlNamespace, 'meta') : doc.createElement('meta');
    csp.setAttribute('http-equiv', 'Content-Security-Policy');
    csp.setAttribute('content', PUBLICATION_CSP);
    const head = doc.head ?? doc.getElementsByTagNameNS(htmlNamespace, 'head')[0];
    if (!head) throw new ReaderHostError('INTEGRITY');
    head.prepend(csp);
    if (isXhtml) return new XMLSerializer().serializeToString(doc);
    return '<!doctype html>\n' + doc.documentElement.outerHTML;
  }
  return new XMLSerializer().serializeToString(doc);
}

export async function openHostPublication(session: ReaderSession) {
  const { EPUB } = await import('foliate-js/epub.js');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const context = session.context;
  if (!context) throw new ReaderHostError('STALE_SESSION');
  const resources = new Map(context.resources.map(resource => [canonicalResourcePath(resource.href), resource]));
  const loader = {
    entries: context.resources.map(resource => ({ filename: resource.href, uncompressedSize: resource.bytes })),
    loadText: async (href: string) => {
      // EPUB probes optional encryption/nav resources. Absent manifest entries
      // return null; they never cause an unrestricted file/network lookup.
      if (!resources.has(canonicalResourcePath(href))) return null;
      const bytes = await session.resource(href);
      const text = decoder.decode(bytes);
      if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new ReaderHostError('DENIED');
      return text;
    },
    loadBlob: async (href: string) => {
      const resource = resources.get(canonicalResourcePath(href));
      if (!resource) return null;
      return new Blob([await session.resource(href)], { type: resource.mediaType });
    },
    getSize: (href: string) => resources.get(canonicalResourcePath(href))?.bytes ?? 0,
  };
  const book = await new EPUB(loader).init();
  book.transformTarget.addEventListener('load', (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (detail.isScript) detail.allow = false;
    // No publisher resource can acquire a remote URL or a native file path.
  });
  book.transformTarget.addEventListener('data', (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (detail.type === 'text/css') detail.data = Promise.resolve(detail.data).then(async (data: string | Blob) =>
      sanitizePublicationCss(data instanceof Blob ? await data.text() : data));
    if (['application/xhtml+xml', 'text/html', 'image/svg+xml'].includes(detail.type)) {
      detail.data = Promise.resolve(detail.data).then(async (data: string | Blob) => {
        const text = data instanceof Blob ? await data.text() : data;
        return sanitizePublicationMarkup(text, detail.type);
      });
    }
  });
  if (book.sections.length > LIMITS.resources) { book.destroy?.(); throw new ReaderHostError('LIMIT'); }
  const active = session.context;
  if (!active || active.sessionId !== context.sessionId || active.epoch !== context.epoch) {
    book.destroy?.(); throw new ReaderHostError('STALE_SESSION');
  }
  const destroy = book.destroy?.bind(book);
  let destroyed = false;
  book.destroy = () => {
    if (destroyed) return;
    destroyed = true; hostPublications.delete(book); destroy?.();
  };
  hostPublications.add(book);
  return book;
}
