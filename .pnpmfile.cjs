// better-auth declares `vitest` and `prisma` as optional peers. pnpm resolves
// optional peers that exist anywhere in the workspace, so `pnpm deploy --prod`
// copied vitest (and vite with it) into the backend runtime image (measured:
// 316 MB -> 373 MB). Neither is used at runtime, so the peer declarations are
// dropped here. `react`/`react-dom` stay: the frontend imports better-auth/react.
const DROPPED_PEERS = ['vitest', 'prisma'];
// Add a package here when it brings the same optional peers into the deploy tree.
const PACKAGES = new Set(['better-auth']);

function readPackage(pkg) {
	if (PACKAGES.has(pkg.name)) {
		for (const peer of DROPPED_PEERS) {
			if (pkg.peerDependencies) delete pkg.peerDependencies[peer];
			if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[peer];
		}
	}
	return pkg;
}

module.exports = { hooks: { readPackage } };
