import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { usernameClient } from "better-auth/client/plugins";
import { customSessionClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
	// Same-origin relative path: frontend nginx proxies /api/ to the backend
	// (AD-3) - no VITE_API_URL needed.
	baseURL: "/api/auth",
	plugins: [
		usernameClient(),
		adminClient(),
		customSessionClient(),
	],
});

export const { signIn, signUp, signOut, useSession, getSession, updateUser } = authClient;
