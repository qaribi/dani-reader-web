# UI localization

`src/i18n/*.json` are UTF-8 catalogs with schemaVersion 1 and catalogVersion
0.1.0. Persian is the source and default. Keys are shared and typed from the
source catalog; missing runtime entries fall back to Persian. Catalog versions
are independent of the application and stored preference versions. Increment the
catalog version for translation changes; increment the schema version only when
its structure changes. Preserve keys when wording changes.

Arabic, Dari, Pashto and Urdu are **initial, unreviewed translations**. Every
message key is listed in `review.keys`; the language picker displays this status.
Dari intentionally shares some wording with Persian, but has its own catalog.
A native reviewer should check meaning, dialect, terminology, punctuation,
accessibility names and short mobile labels in context. Remove only reviewed
keys from `review.keys`; set status to `reviewed` only when the list is empty.
Record reviewer/date and increment catalogVersion in the review PR. A passing
test is not linguistic approval.

## State and direction

The language preference uses localStorage key `dani-reader-ui-language-v1` with
`{ version: 1, locale }`; unknown/corrupt values default to Persian. Blocked storage
does not prevent changing language for the current session. No IndexedDB schema
migration is needed. Books, annotations, CFI and reading settings retain their
existing stores. Context updates do not key/remount ReaderPage or restart its
session effect. Async status stores stable message IDs, so messages already on
screen and errors arriving after a switch use the current language.

All five interfaces are RTL. The top document lang/dir and title update; the
publication's sandbox retains its own metadata and direction. User titles,
contents entries and notes use automatic direction or bidi isolation; interpolated
values use FSI/PDI. Never pass interpolated messages to innerHTML. Numbers and
percentages use Intl.NumberFormat (Arabic digits for Arabic; extended Arabic digits
for the other four). Machine IDs, CFI and versions remain unchanged. Fonts are
system fallbacks, without network font requests. Urdu receives more line height;
check glyph coverage on each target OS before release.

## Verification

Run `npm test` and `npm run build`. For the real browser state regression, install
the pinned dependencies (`npm ci --ignore-scripts`) and Chromium
(`npx playwright install chromium`), then run `npm run test:browser` after building.
The test starts and stops its own production preview server. CI runs this check. The script imports an original EPUB, navigates,
saves a note, changes settings, switches all five locales, verifies the same
reader element and location, and compares IndexedDB state/settings before and
after switching. It also verifies draft text and preference after reload.

Manually inspect narrow screens and 200% zoom in every language, mixed Latin/RTL
titles, note entry, errors, keyboard focus and publication navigation direction.
