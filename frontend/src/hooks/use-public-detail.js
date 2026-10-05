import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import { settingsService, DEFAULT_STORE_TITLE } from '../services/api';

const normalizeCode = (code) => String(code ?? '').trim().toUpperCase();

/**
 * Loads a public product/combo by its code for a detail page.
 *
 * `fetcher(code)` must resolve to `{ success, data }` and reject with an error
 * carrying `status` (404 means not found). The result is keyed by the code it
 * was fetched for, so after a route change the old record is never exposed,
 * and never used to redirect the new URL back to the old path.
 */
const usePublicDetail = (fetcher, code) => {
	const location = useLocation();
	const navigate = useNavigate();
	const fetcherRef = useRef(fetcher);
	fetcherRef.current = fetcher;

	// loading | ready | notfound | error, valid only for `result.code`.
	const [result, setResult] = useState({ code: null, status: 'loading', data: null });
	const [storeTitle, setStoreTitle] = useState(DEFAULT_STORE_TITLE);
	const [reloadKey, setReloadKey] = useState(0);

	useEffect(() => {
		let active = true;
		setResult({ code, status: 'loading', data: null });
		fetcherRef.current(code)
			.then((response) => {
				if (!active) return;
				if (!response.success || !response.data) {
					setResult({ code, status: 'notfound', data: null });
					return;
				}
				setResult({ code, status: 'ready', data: response.data });
			})
			.catch((error) => {
				if (!active) return;
				if (error.status === 404) {
					setResult({ code, status: 'notfound', data: null });
					return;
				}
				toast.error(error.message);
				setResult({ code, status: 'error', data: null });
			});
		return () => {
			active = false;
		};
	}, [code, reloadKey]);

	useEffect(() => {
		let active = true;
		settingsService.getPublicSettings()
			.then((settings) => {
				if (active && settings?.storeTitle) setStoreTitle(settings.storeTitle);
			})
			.catch(() => {
				// The title suffix is cosmetic; the default stays.
			});
		return () => {
			active = false;
		};
	}, []);

	const current = result.code === code;
	const status = current ? result.status : 'loading';
	const data = current && result.status === 'ready' ? result.data : null;

	// A typed URL may carry a wrong slug or tracking query; replacing it keeps Back from looping.
	// The code check stops a record that belongs to the previous route from redirecting this one.
	useEffect(() => {
		if (!data?.path || data.publicCode !== normalizeCode(code)) return;
		if (location.pathname !== data.path || location.search) {
			navigate(data.path, { replace: true });
		}
	}, [data, code, location.pathname, location.search, navigate]);

	useEffect(() => {
		if (!data) return undefined;
		const previous = document.title;
		document.title = `${data.name} — ${storeTitle}`;
		return () => {
			document.title = previous;
		};
	}, [data, storeTitle]);

	const retry = useCallback(() => setReloadKey((key) => key + 1), []);

	return { data, status, retry, storeTitle };
};

export default usePublicDetail;
