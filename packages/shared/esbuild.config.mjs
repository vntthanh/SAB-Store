// Builds the one source into the two formats consumers load: ESM for Vite and
// CommonJS for the backend (Jest 29 cannot require() an ES module). The output folder is wiped first so a deleted module never
// lingers.
import { rmSync } from 'node:fs';
import { context, build } from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
	entryPoints: ['src/index.js'],
	bundle: true,
	platform: 'neutral',
	target: 'es2020',
	// One zod instance for every consumer: the global error map registered in
	// src/z.js must apply to the schemas the consumers run.
	external: ['zod'],
	logLevel: 'info',
};
const targets = [
	{ ...common, format: 'esm', outfile: 'dist/index.js' },
	{ ...common, format: 'cjs', outfile: 'dist/index.cjs' },
];

rmSync('dist', { recursive: true, force: true });

if (watch) {
	for (const options of targets) {
		await (await context(options)).watch();
	}
} else {
	await Promise.all(targets.map((options) => build(options)));
}
