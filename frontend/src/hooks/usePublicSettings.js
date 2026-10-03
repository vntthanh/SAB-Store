import { useEffect, useState } from 'react';
import { settingsService } from '../services/api';

/**
 * Public storefront settings, or null until they arrive. Pages render nothing
 * for a setting while it is null rather than a guessed default, so a customer
 * never sees a reminder that the admin has since changed or removed.
 */
const usePublicSettings = () => {
	const [settings, setSettings] = useState(null);

	useEffect(() => {
		let active = true;
		settingsService.getPublicSettings()
			.then((data) => {
				if (active) setSettings(data);
			})
			.catch((error) => {
				console.error('Error loading public settings:', error);
			});
		return () => {
			active = false;
		};
	}, []);

	return settings;
};

export default usePublicSettings;
