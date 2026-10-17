import { ReaderHostError } from './host-contract.ts';
import { translate } from '../i18n/core.ts';
import type { Locale, MessageKey } from '../i18n/core.ts';
export const readerErrorKey = (error: unknown): MessageKey =>
  `error${error instanceof ReaderHostError ? error.code : 'UNAVAILABLE'}` as MessageKey;
export const readerErrorMessage = (error: unknown, locale: Locale = 'fa') => translate(locale, readerErrorKey(error));
