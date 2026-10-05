// Include corresponding-source directions and every shipped runtime license.
import { copyFile, cp, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = join(root, 'dist');
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md'])
  await copyFile(join(root, name), join(target, name));
await cp(join(root, 'licenses'), join(target, 'licenses'), { recursive: true });
await mkdir(join(target, 'licenses', 'vendor'), { recursive: true });
await copyFile(join(root, 'vendor', 'foliate-js', 'LICENSE'), join(target, 'licenses', 'vendor', 'foliate-js-LICENSE'));
await writeFile(join(target, 'SOURCE_AND_BUILD.txt'), `DANI Reader Web — corresponding source\nhttps://github.com/qaribi/dani-reader-web\nFirst release source tag: v0.1.0\n\nUse the source tag matching this distribution. Full source includes the patched\nFoliate engine, fixtures and package-lock.json. Source license is AGPL-3.0-or-later;\nsee LICENSE and THIRD_PARTY_NOTICES.md and licenses/ for dependency terms.\n\nRebuild with Node 24.19.0 and npm 12.2.0:\nnpm ci --ignore-scripts\nnpm test\nnpm run build\n\nServe dist/ from a dedicated HTTP origin. Books and notes remain in IndexedDB.\nSee SECURITY.md for deployment CSP and the tested browser boundary.\n`, 'utf8');
