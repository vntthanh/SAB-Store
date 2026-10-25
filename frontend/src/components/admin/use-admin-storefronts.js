import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { storefrontAdminService } from '../../services/api';

/**
 * Every storefront (active or not, display order) for the admin selectors, filters and
 * name lookups. `nameOf` falls back to the id so a row never renders blank.
 */
const useAdminStorefronts = () => {
	const [storefronts, setStorefronts] = useState([]);
	const [loading, setLoading] = useState(true);

	const reload = useCallback(async () => {
		try {
			const response = await storefrontAdminService.list();
			setStorefronts(response.data || []);
		} catch (error) {
			toast.error(error.message);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		reload();
	}, [reload]);

	const nameOf = useMemo(() => {
		const names = new Map(storefronts.map((storefront) => [storefront._id, storefront.name]));
		return (id) => names.get(id) || id || '—';
	}, [storefronts]);

	return { storefronts, loading, reload, nameOf };
};

export default useAdminStorefronts;
