// Peers whose X-Forwarded-For Express believes. Production path is
// Traefik -> frontend nginx -> backend, all on the Coolify project network.
// Coolify allocates that subnet and the compose file may not pin it, so a CIDR
// range is used rather than a hop count: a hop count silently mis-attributes
// every visitor if a proxy is ever added or removed, a range only fails if the
// network moves outside it. Override with TRUSTED_PROXY_IPS (comma-separated).
//
// Better Auth 1.3.x has no trusted-proxy option: it reads the leftmost
// X-Forwarded-For entry. That is the real client because Traefik overwrites the
// header and nginx forwards it verbatim, so Better Auth needs no counterpart.
const DEFAULT_TRUSTED_PROXIES = Object.freeze(['loopback', '10.0.0.0/16']);

function buildTrustedProxies(env = process.env.TRUSTED_PROXY_IPS) {
	const entries = (env || '')
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
	return entries.length > 0 ? entries : [...DEFAULT_TRUSTED_PROXIES];
}

module.exports = { DEFAULT_TRUSTED_PROXIES, buildTrustedProxies };
