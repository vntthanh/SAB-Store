/**
 * Vitest's vi.resetModules() only clears its own module graph. The application
 * code is loaded with Node's native require(), whose cache it never touches, so
 * a test that needs a module to evaluate again (with different env) must evict
 * it from require.cache itself.
 */
const path = require('path');
const mongoose = require('mongoose');

const backendRoot = path.resolve(__dirname, '..', '..');
const testsDir = path.join(backendRoot, 'tests') + path.sep;
const generatedDir = path.join(backendRoot, 'generated') + path.sep;
const dependencyDir = `${path.sep}node${'_'}modules${path.sep}`;

// Evicts every application module (everything under backend/ except installed
// packages and the test helpers, plus the mongoose model registry) so the next
// require() re-runs it. Test helpers stay cached so tests/setup.js keeps closing
// the same server registry; third-party packages and the generated Prisma client
// stay cached because they hold no state under test and re-evaluating them is
// slow. Returns a promise: the current
// better-auth MongoClient and the Prisma pool are closed first, or the
// re-required modules open second ones and the first are never closed.
async function clearAppModules() {
	const authPath = path.join(backendRoot, 'lib', 'auth.js');
	if (require.cache[authPath]) await require.cache[authPath].exports.client?.close();
	const prismaPath = path.join(backendRoot, 'lib', 'prisma.js');
	if (require.cache[prismaPath]) await require.cache[prismaPath].exports.closeDb();
	// mongoose is a cached package, so its model registry would otherwise make the
	// re-evaluated model files throw OverwriteModelError.
	for (const name of mongoose.modelNames()) mongoose.deleteModel(name);
	for (const key of Object.keys(require.cache)) {
		if (key.startsWith(backendRoot + path.sep) && !key.startsWith(testsDir) && !key.startsWith(generatedDir) && !key.includes(dependencyDir)) {
			delete require.cache[key];
		}
	}
}

module.exports = { clearAppModules };
