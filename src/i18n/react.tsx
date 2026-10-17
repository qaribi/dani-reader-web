import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { catalogs, formatNumber, isLocale, loadLocale, localeInfo, locales, persistLocale, translate } from './core.ts';
import type { Locale, MessageKey } from './core.ts';

const LocaleContext = createContext<{ locale: Locale; setLocale(locale: Locale): void } | null>(null);
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => {
    try { return loadLocale(window.localStorage); } catch { return 'fa'; }
  });
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = 'rtl';
    document.title = translate(locale, 'libraryTitle');
    try { persistLocale(locale, window.localStorage); } catch { /* Storage may be disabled. */ }
  }, [locale]);
  // No locale key: updating context preserves the mounted reader and its realm.
  return <LocaleContext value={{ locale, setLocale }}>{children}</LocaleContext>;
}
export function useI18n() {
  const context = useContext(LocaleContext);
  if (!context) throw new Error('I18nProvider required');
  const { locale } = context;
  return {
    ...context,
    t: (key: MessageKey, values?: Record<string, string | number>) => translate(locale, key, values),
    number: (value: number, options?: Intl.NumberFormatOptions) => formatNumber(locale, value, options),
    percent: (value: number) => formatNumber(locale, value, { style: 'percent', maximumFractionDigits: 0 }),
  };
}
export function LanguagePicker() {
  const { locale, setLocale, t } = useI18n();
  return <div className="language-picker"><label>{t('interfaceLanguage')} <select value={locale} onChange={event => {
    if (isLocale(event.target.value)) setLocale(event.target.value);
  }}>{locales.map(code => <option key={code} value={code} lang={code} dir="rtl">{localeInfo[code].name}</option>)}</select></label>
    {catalogs[locale].review.status === 'needs-native-review' && <small lang={locale}>{t('reviewNotice')}</small>}
  </div>;
}
