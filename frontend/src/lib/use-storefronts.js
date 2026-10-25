import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getStorefronts } from '../services/api';
import { useSession } from './auth-client';

/**
 * Who is looking, as a stable key. Access to a private storefront depends on it,
 * so anything fetched per viewer lists `key` as a dependency and refetches on
 * sign-in or sign-out without a reload. `ready` is false until the first session
 * lookup settles; fetches do not wait for it (the request carries the cookie, so
 * the answer is already right for the signed-in viewer) and simply run again if
 * the key changes once the session resolves.
 */
export const useAuthIdentity = () => {
	const { data, isPending } = useSession();
	const user = data?.user ?? null;
	return { ready: !isPending, key: user?.id ?? 'anonymous', user };
};

// One list shared by every consumer: "/" redirects to "/s/:slug" and both pages
// (plus the gate and checkout) need it, so a per-hook state would fetch it twice.
let snapshot = { status: 'loading', storefronts: [], error: null, key: null };
let inflightKey = null;
let requestSeq = 0;
const listeners = new Set();

const publish = (next) => {
	snapshot = next;
	listeners.forEach((listener) => listener());
};

const subscribe = (listener) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

const getSnapshot = () => snapshot;

const loadStorefronts = (key, { force = false } = {}) => {
	if (!force && (snapshot.key === key && snapshot.status === 'ready')) return;
	if (!force && inflightKey === key) return;
	inflightKey = key;
	// A response from a superseded request (another identity, or a forced reload) is dropped.
	const seq = ++requestSeq;
	if (snapshot.key !== key || snapshot.status !== 'ready') {
		publish({ status: 'loading', storefronts: [], error: null, key });
	}
	getStorefronts()
		.then((response) => {
			if (seq !== requestSeq) return;
			inflightKey = null;
			publish({ status: 'ready', storefronts: response?.storefronts ?? [], error: null, key });
		})
		.catch((error) => {
			if (seq !== requestSeq) return;
			inflightKey = null;
			publish({ status: 'error', storefronts: [], error, key });
		});
};

/** The active storefronts as the current viewer sees them (lock and access flags included). */
export const useStorefronts = () => {
	const identity = useAuthIdentity();
	const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

	useEffect(() => {
		// A failed list is retried when a page mounts, not in a loop.
		loadStorefronts(identity.key, { force: snapshot.key === identity.key && snapshot.status === 'error' });
	}, [identity.key]);

	const reload = useCallback(() => loadStorefronts(identity.key, { force: true }), [identity.key]);

	// Until the store has caught up with this viewer, the previous viewer's list is not shown.
	if (current.key !== identity.key) return { status: 'loading', storefronts: [], error: null, reload };
	return { status: current.status, storefronts: current.storefronts, error: current.error, reload };
};
