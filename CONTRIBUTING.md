# Contributing

Use Node 24.19.0 and npm 12.2.0, then run `npm ci --ignore-scripts`, `npm test` and `npm run build`. Install scripts remain disabled for the pinned dependency set. Use a separate loopback origin for browser tests so your personal books and notes are not part of a reproduction.

The working integration is `src/App.tsx`: `importEpub(file)` returns detached bytes and a content-hash identity, `LocalLibrary.put(book)` stores the admitted book, and `ReaderPage` receives the publication, library, settings and exit callback. Keep a reader session scoped to a single book. State writes must preserve atomic revision checks and cancellation. Changes to the resource loader or vendor engine must preserve the sandbox, CSP and local URL boundary.

For a language regression, add original text to `scripts/generate-fixtures.py`, generate the fixture and describe the specific expected behavior. Verify joining, diacritics, mixed Latin/numbers, page progression, TOC, search, line height and clipping in the target browser. Include a screenshot when it helps assess layout. State whether the report is a rendered synthetic check or a native speaker's language review.

For functional changes, exercise the affected workflow through the UI. Annotation changes require chapter switching, reopen and visible deletion checks; persistence changes require save/exit/reopen and storage-error handling. Security changes require malicious synthetic EPUBs and observation of attempted network traffic, including SVG/CSS and fixed-layout content.

Do not contribute private DANI services, authentication, DRM implementations, production configuration, credentials, user data or books without redistribution rights. Preserve AGPL corresponding-source obligations and the shipped third-party notices. Use minimal synthetic examples in public issues.
