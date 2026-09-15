import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { usernameClient } from "better-auth/client/plugins";
import { customSessionClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
	// Same origin: the frontend nginx proxies /api/ to the backend, so no
	// build-time domain variable is needed (AD-3).
	//
	// It must still be an ABSOLUTE url. better-auth's client validates this and
	// throws "Invalid base URL" on a relative path, which happens at import
	// time and takes the whole SPA down with a blank page. Deriving it from
	// window.location keeps the domain out of the bundle.
	baseURL: `${window.location.origin}/api/auth`,
	plugins: [
		usernameClient(),
		adminClient(),
		customSessionClient(),
	],
});

export const { signIn, signUp, signOut, useSession, getSession, updateUser } = authClient;
