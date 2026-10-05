import { ReaderHostError } from './host-contract.ts';
import type { HostErrorCode } from './host-contract.ts';

const messages: Record<HostErrorCode, string> = {
  LIMIT: 'کتاب، کتابخانه یا یادداشت از اندازهٔ مجاز بزرگ‌تر است؛ کتاب کوچک‌تر انتخاب کنید یا یادداشت‌ها و کتاب‌های غیرضروری را کم کنید.',
  DENIED: 'کتاب رمزگذاری‌شده، ارجاع بیرونی یا محتوای پشتیبانی‌نشده پذیرفته نمی‌شود؛ یک EPUB 3 محلی و بدون رمزگذاری انتخاب کنید.',
  INTEGRITY: 'فایل EPUB خراب، ناقص یا دارای متن XML ناسازگار است؛ نسخهٔ سالم با XML به رمزگذاری UTF-8 انتخاب کنید.',
  INVALID_MESSAGE: 'دادهٔ مطالعه معتبر نیست؛ کتاب را ببندید و دوباره باز کنید.',
  STALE_SESSION: 'نشست مطالعه بسته شده است؛ کتاب را دوباره باز کنید.',
  STORAGE: 'مرورگر نتوانست کتاب یا یادداشت را ذخیره کند؛ فضای ذخیره‌سازی و امکان نگهداری داده در این مرورگر را بررسی کنید.',
  UNAVAILABLE: 'ریدِر در دسترس نیست؛ کتاب را دوباره در نسخهٔ جدید Chrome باز کنید.',
  CONFLICT: 'وضعیت مطالعه در پنجرهٔ دیگری تغییر کرده است؛ کتاب را دوباره باز کنید و ذخیره را تکرار کنید.',
  NOT_IMPLEMENTED: 'این قابلیت در نسخهٔ فعلی پشتیبانی نمی‌شود.',
};
export const readerErrorMessage = (error: unknown) => messages[error instanceof ReaderHostError ? error.code : 'UNAVAILABLE'];
