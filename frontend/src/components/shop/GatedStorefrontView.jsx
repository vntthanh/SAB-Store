import React from 'react';
import { useStorefronts } from '../../lib/use-storefronts';
import StorefrontTabs from './StorefrontTabs';
import PrivateStorefrontGate from './PrivateStorefrontGate';

// A deep link to a private item: the 401/403 names the storefront (slug, name), which the
// locked tab already shows, so the page can sit under that tab with the gate in place of the item.
const GatedStorefrontView = ({ error, onAccessChanged }) => {
	const { storefronts } = useStorefronts();
	return (
		<>
			<StorefrontTabs storefronts={storefronts} activeSlug={error?.storefront?.slug} />
			<PrivateStorefrontGate storefront={error?.storefront} error={error} onAccessChanged={onAccessChanged} />
		</>
	);
};

export default GatedStorefrontView;
