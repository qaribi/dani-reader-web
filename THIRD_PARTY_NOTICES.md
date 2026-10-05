# Provenance and shipped notices

The reading UI and bounded host/publication/lifetime/search components were adapted with the owner's publication authorization from the existing DANI reader's Readest-based source. The independent edition replaces the original private host transport with a local unencrypted-content adapter and adds a standalone library, storage and application wrapper. No private service implementation or Git history was transferred.

Readest upstream base: `readest/readest@8a56831af61841175b49cc2740bffcde57b470b0` (v0.12.10), AGPL-3.0-or-later. The complete license is in [LICENSE](LICENSE). This standalone application retains that license; engine MIT licensing does not relicense the application.

Foliate public source: `readest/foliate-js@341dc63cda7ad26b31ada4ee905e40b5020da88a`, MIT. The nine vendored files retain upstream copyright headers and [the complete MIT license](vendor/foliate-js/LICENSE). Three changes are intentionally recorded: `paginator.js` removes `allow-scripts` at one iframe sandbox; `fixed-layout.js` removes it at two sandboxes; `epub.js` refuses external content URLs. These changes target Chromium publication isolation and must not be silently undone for WebKit compatibility.

Runtime package versions and notices are kept in `package-lock.json` and `licenses/runtime`: React/React DOM 19.2.8 and Scheduler (MIT), @zip.js/zip.js 2.8.16 (BSD-3-Clause), and construct-style-sheets-polyfill 3.1.0 (MIT). Build dependencies are separately pinned in the lock, with Apache-2.0, BSD-3-Clause, ISC, MIT and MPL-2.0 license metadata. Install with `npm ci --ignore-scripts`; optional platform hooks are not needed by this verified build.

The fixture generator and test prose are newly written for this edition. Synthetic EPUBs are generated locally with fixed timestamps and permissions; no upstream novels, private books, fonts or production assets are included. System fonts are used; no font file is distributed.

Corresponding source includes the full application, vendored engine, lock, original fixture generator and build instructions. Distributors must preserve AGPL obligations and third-party notices; see the license for the exact terms.
