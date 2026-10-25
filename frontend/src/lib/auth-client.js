import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { usernameClient } from "better-auth/client/plugins";
import { customSessionClient } from "better-auth/client/plugins";
import { emailOTPClient } from "better-auth/client/plugins";

// Same origin: the frontend nginx proxies /api/ to the backend, so no
// build-time domain variable is needed (AD-3).
//
// It must still be an ABSOLUTE url. better-auth's client validates this and
// throws "Invalid base URL" on a relative path, which happens at import
// time and takes the whole SPA down with a blank page. Deriving it from
// window.location keeps the domain out of the bundle.
export const AUTH_BASE_URL = `${window.location.origin}/api/auth`;

export const authClient = createAuthClient({
	baseURL: AUTH_BASE_URL,
	plugins: [
		usernameClient(),
		adminClient(),
		customSessionClient(),
		emailOTPClient(),
	],
});

export const { useSession } = authClient;

/**
 * Re-reads the session for every `useSession()` consumer. Sign-ins made through
 * a different client instance (Google One Tap is built per client id) do not
 * trigger this client's own session refresh.
 */
export const refreshSession = () => {
	authClient.$store.notify("$sessionSignal");
};

/** The current session straight from the server (skips any cookie cache), or null. */
export const fetchFreshSession = async () => {
	const { data } = await authClient.getSession({ query: { disableCookieCache: true } });
	return data ?? null;
};
