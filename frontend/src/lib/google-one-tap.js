import { createAuthClient } from 'better-auth/react';
import { oneTapClient } from 'better-auth/client/plugins';
import { AUTH_BASE_URL } from './auth-client';

// Google rejects a width outside this range.
const BUTTON_MIN_PX = 200;
const BUTTON_MAX_PX = 400;
const BUTTON_FALLBACK_PX = 320;

// createAuthClient bakes plugin options in at construction and the client id is
// only known after GET /api/settings, so the One Tap client is built lazily and
// kept per id. This keeps the image a single build for every deployment.
let cached = null;

const clientFor = (clientId) => {
	if (cached?.clientId !== clientId) {
		cached = {
			clientId,
			client: createAuthClient({
				baseURL: AUTH_BASE_URL,
				plugins: [oneTapClient({ clientId, autoSelect: false, uxMode: 'popup' })],
			}),
		};
	}
	return cached.client;
};

// Layout width, not getBoundingClientRect: a dialog opening with a scale
// animation would otherwise be measured shrunken.
const widthFor = (container) => {
	const measured = container.clientWidth;
	const width = measured > 0 ? measured : BUTTON_FALLBACK_PX;
	return Math.min(BUTTON_MAX_PX, Math.max(BUTTON_MIN_PX, Math.round(width)));
};

/**
 * Renders Google's own "Sign in with Google" button into `container`.
 *
 * Button mode on purpose: the floating One Tap prompt is silenced by browser
 * state and Google's cooldown after a dismissal, which looks like a bug. The
 * button always exists and always reacts to a click. `uxMode` must stay
 * 'popup': 'redirect' form-POSTs to a login_uri the plugin never sets.
 *
 * Resolves once the button is drawn; `onSuccess` fires after the server has
 * accepted the credential and set the session cookie.
 */
export const renderGoogleButton = async ({ clientId, container, onSuccess, onError }) => {
	const id = typeof clientId === 'string' ? clientId.trim() : '';
	if (!id || !container) return;

	// Drawing twice (StrictMode, a re-render) would stack two buttons.
	container.replaceChildren();

	await clientFor(id).oneTap({
		button: {
			container,
			config: {
				theme: 'outline',
				size: 'large',
				type: 'standard',
				text: 'signin_with',
				shape: 'rectangular',
				width: widthFor(container),
			},
		},
		fetchOptions: {
			onSuccess: () => onSuccess(),
			onError: (ctx) => onError?.(ctx?.error ?? null),
		},
	});
};
