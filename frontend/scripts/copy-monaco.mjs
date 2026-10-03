// Copies the Monaco AMD bundle out of the installed `monaco-editor` package into
// `public/`, so the admin editor loads from this origin instead of the
// cdn.jsdelivr.net default of @monaco-editor/loader (outside our CSP's
// script-src 'self', and dead whenever the CDN is unreachable).
//
// The source is the installed package, so `yarn upgrade monaco-editor` is the
// whole update procedure and the served bundle cannot drift from package.json.
// The output is gitignored, a build artifact like build/.
//
// Called explicitly from the `dev` and `build` scripts: a missing copy only shows
// up as a 404 in the browser at runtime, never as a build failure.
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MONACO_VS_PATH } from '../src/lib/monaco-assets.js';

// The browser requests MONACO_VS_PATH; derive the copy target from the same constant.
const DEST_REL = path.join('public', MONACO_VS_PATH);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// monaco-editor's `exports` map does not expose package.json, so resolve the main
// entry and walk up to the directory whose package.json names the package.
const findPackageRoot = async (name) => {
	let dir = path.dirname(require.resolve(name));
	while (dir !== path.dirname(dir)) {
		const pkg = await readFile(path.join(dir, 'package.json'), 'utf8').then(JSON.parse, () => null);
		if (pkg?.name === name) return { dir, version: pkg.version };
		dir = path.dirname(dir);
	}
	throw new Error(`monaco: package root of ${name} not found`);
};

const { dir: pkgRoot, version } = await findPackageRoot('monaco-editor');

const src = path.join(pkgRoot, 'min', 'vs');
const dest = path.join(root, DEST_REL);
const stamp = path.join(path.dirname(dest), '.version');

try {
	await access(src);
} catch {
	console.error(`monaco: ${src} not found - is monaco-editor installed?`);
	process.exit(1);
}

// `dev` runs this on every start; skip re-copying several MB of unchanged files.
if ((await readFile(stamp, 'utf8').catch(() => null)) === version) {
	console.log(`monaco: ${version} already in ${DEST_REL}`);
	process.exit(0);
}

// Full replace, not a merge: an upstream file removal would otherwise leave
// orphans the AMD loader can still resolve.
await rm(path.dirname(dest), { recursive: true, force: true });
await mkdir(path.dirname(dest), { recursive: true });
await cp(src, dest, { recursive: true });
await writeFile(stamp, version);

console.log(`monaco: copied ${version} -> ${DEST_REL}`);
