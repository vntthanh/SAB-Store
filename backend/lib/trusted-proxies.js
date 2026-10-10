const net = require('node:net');

// Peers whose X-Forwarded-For is believed. Production path is
// Traefik -> frontend nginx -> backend, all on the Coolify project network.
// Coolify allocates that subnet and the compose file may not pin it, so a CIDR
// range is used rather than a hop count: a hop count silently mis-attributes
// every visitor if a proxy is ever added or removed, a range only fails if the
// network moves outside it. Override with TRUSTED_PROXY_IPS (comma-separated).
//
// Two consumers read this one list: Express (`trust proxy`, as written) and
// Better Auth (`advanced.ipAddress.trustedProxies`, through toCidrs). Better
// Auth only understands IPs and CIDRs and discards anything else without
// failing, which would leave every client keyed into one shared rate-limit
// bucket; toCidrs therefore rejects at boot whatever it cannot express.
const DEFAULT_TRUSTED_PROXIES = Object.freeze(['loopback', '10.0.0.0/16']);

// Express's named ranges, as CIDRs.
const NAMED_RANGES = Object.freeze({
	loopback: ['127.0.0.0/8', '::1/128'],
	linklocal: ['169.254.0.0/16', 'fe80::/10'],
	uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
});

function buildTrustedProxies(env = process.env.TRUSTED_PROXY_IPS) {
	const entries = (env || '')
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
	return entries.length > 0 ? entries : [...DEFAULT_TRUSTED_PROXIES];
}

// Zone ids ("fe80::1%eth0") are interface-local and prefix 0 would trust every
// address, so neither is a meaningful proxy entry.
function isValidAddressOrCidr(entry) {
	if (entry.includes('%')) return false;
	const slash = entry.indexOf('/');
	const address = slash === -1 ? entry : entry.slice(0, slash);
	const family = net.isIP(address);
	if (family === 0) return false;
	if (slash === -1) return true;
	const prefix = entry.slice(slash + 1);
	return /^\d{1,3}$/.test(prefix) && Number(prefix) >= 1 && Number(prefix) <= (family === 4 ? 32 : 128);
}

/**
 * Expands a trusted-proxy list into the IP/CIDR form Better Auth accepts.
 * Throws on a hop count, a typo or a netmask form instead of dropping it.
 */
function toCidrs(entries) {
	return entries.flatMap((entry) => {
		if (Object.hasOwn(NAMED_RANGES, entry)) return NAMED_RANGES[entry];
		if (isValidAddressOrCidr(entry)) return [entry];
		throw new Error(
			`Invalid trusted proxy "${entry}" (TRUSTED_PROXY_IPS): use loopback, linklocal, uniquelocal, an IP address or a CIDR such as 10.0.0.0/16`
		);
	});
}

module.exports = { DEFAULT_TRUSTED_PROXIES, buildTrustedProxies, toCidrs };
