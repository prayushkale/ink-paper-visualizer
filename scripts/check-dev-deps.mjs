/**
 * Guards the dev loop against a machine-level `omit=dev` in npm config.
 *
 * This project cannot run without its devDependencies (vite, vitest,
 * concurrently), but a global `npm config set omit dev` silently strips them,
 * which then surfaces as a confusing "vitest: command not found". Fail early
 * with the exact command that fixes it.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const required = ['vite', 'vitest', 'concurrently', 'typescript'];
const missing = required.filter((name) => !existsSync(join(root, 'node_modules', name)));

if (missing.length > 0) {
  console.error(
    `\n  Missing dev dependencies: ${missing.join(', ')}\n\n` +
    '  This usually means npm omitted devDependencies (a global `omit=dev`).\n' +
    '  Fix it with:\n\n' +
    '      npm install --include=dev\n',
  );
  process.exit(1);
}
