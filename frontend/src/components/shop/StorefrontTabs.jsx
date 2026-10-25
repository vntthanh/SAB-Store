import React from 'react';
import { Link } from 'react-router-dom';
import { storefrontPath } from '../../lib/storefront-tabs';

// The URL (/s/:slug) is the source of truth for the active tab, so a tab is a
// plain link: Back, reload and shared links all land on the same storefront.
// `activeSlug` may name a storefront missing from `storefronts` (a deep link to a
// locked item), in which case no tab is highlighted.
const StorefrontTabs = ({ storefronts, activeSlug }) => {
	if (!storefronts || storefronts.length === 0) return null;
	// A lone public shop has nothing to switch between: it looks like the shop before storefronts existed.
	if (storefronts.length === 1 && storefronts[0].visibility === 'PUBLIC') return null;

	return (
		<nav aria-label="Gian hàng" className="border-b border-gray-200 bg-white">
			<div className="container mx-auto px-4">
				{/* No wrap: on a phone the row scrolls sideways instead of stacking tabs. */}
				<ul className="-mb-px flex flex-nowrap gap-1 overflow-x-auto">
					{storefronts.map((storefront) => {
						const active = storefront.slug === activeSlug;
						return (
							<li key={storefront.id} className="shrink-0">
								<Link
									to={storefrontPath(storefront.slug)}
									aria-current={active ? 'page' : undefined}
									className={[
										'flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium transition-colors',
										active
											? 'border-primary-600 text-primary-700'
											: 'border-transparent text-gray-600 hover:border-gray-300 hover:text-gray-900',
									].join(' ')}
								>
									{storefront.visibility === 'PRIVATE' && (
										<i
											className={`fas ${storefront.locked ? 'fa-lock text-gray-400' : 'fa-lock-open text-green-600'}`}
											title={storefront.locked ? 'Cần đăng nhập' : 'Gian hàng riêng tư'}
										></i>
									)}
									{storefront.name}
								</Link>
							</li>
						);
					})}
				</ul>
			</div>
		</nav>
	);
};

export default StorefrontTabs;
