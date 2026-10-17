import fa from './fa.json' with { type: 'json' };
import ar from './ar.json' with { type: 'json' };
import prs from './prs.json' with { type: 'json' };
import ps from './ps.json' with { type: 'json' };
import ur from './ur.json' with { type: 'json' };

export const catalogs = { fa, ar, prs, ps, ur };
export type Locale = keyof typeof catalogs;
export type MessageKey = keyof typeof fa.messages;
export const locales: Locale[] = ['fa', 'ar', 'prs', 'ps', 'ur'];
export const localeInfo = {
  fa: { name: 'فارسی', intl: 'fa-IR', digits: 'arabext' },
  ar: { name: 'العربية', intl: 'ar', digits: 'arab' },
  prs: { name: 'دری', intl: 'fa-AF', digits: 'arabext' },
  ps: { name: 'پښتو', intl: 'ps-AF', digits: 'arabext' },
  ur: { name: 'اردو', intl: 'ur-PK', digits: 'arabext' },
} as const;
export const preferenceKey = 'dani-reader-ui-language-v1';
export const isLocale = (value: unknown): value is Locale => locales.includes(value as Locale);
// No publication, IndexedDB, reading settings or locator is touched by this store.
export function loadLocale(storage?: Pick<Storage, 'getItem'>): Locale {
  try {
    const value = JSON.parse(storage?.getItem(preferenceKey) ?? 'null');
    return value?.version === 1 && isLocale(value.locale) ? value.locale : 'fa';
  } catch { return 'fa'; }
}
export function persistLocale(locale: Locale, storage?: Pick<Storage, 'setItem'>): void {
  try { storage?.setItem(preferenceKey, JSON.stringify({ version: 1, locale })); }
  catch { /* Private/blocked storage: switching still works for this session. */ }
}
export function translate(locale: Locale, key: MessageKey, values: Record<string, string | number> = {}): string {
  const template = catalogs[locale]?.messages[key] ?? fa.messages[key];
  // Isolate interpolated titles, versions and counts from surrounding RTL text.
  return template.replace(/\{(\w+)\}/g, (token, name: string) =>
    Object.hasOwn(values, name) ? `\u2068${values[name]}\u2069` : token);
}
// Status state stores message IDs, never translated prose, including async errors.
export function statusText(status: string, locale: Locale): string {
  return status.split('\u001f').filter(Boolean).map(key =>
    Object.hasOwn(fa.messages, key) ? translate(locale, key as MessageKey) : translate(locale, 'errorUNAVAILABLE')).join('');
}
export function formatNumber(locale: Locale, value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(localeInfo[locale].intl, { ...options, numberingSystem: localeInfo[locale].digits }).format(value);
}
