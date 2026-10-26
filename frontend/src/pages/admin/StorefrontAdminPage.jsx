import React from 'react';
import { useSearchParams } from 'react-router-dom';
import StorefrontManagement from './StorefrontManagement';
import EmailListManagement from './EmailListManagement';

export const ADMIN_STOREFRONT_TABS = [
	{ key: 'storefronts', label: 'Gian hàng', icon: 'fa-store' },
	{ key: 'email-lists', label: 'Danh sách email', icon: 'fa-envelope-open-text' }
];

/** The tab named by `?tab=`, falling back to the first one for a missing or unknown value. */
export const activeTabKey = (param) => (
	ADMIN_STOREFRONT_TABS.some((tab) => tab.key === param) ? param : ADMIN_STOREFRONT_TABS[0].key
);

// The URL holds the tab so a reload, a shared link and the old /admin/email-lists
// redirect all land on the right one.
const StorefrontAdminPage = () => {
	const [searchParams, setSearchParams] = useSearchParams();
	const active = activeTabKey(searchParams.get('tab'));

	const select = (key) => {
		setSearchParams(key === ADMIN_STOREFRONT_TABS[0].key ? {} : { tab: key });
	};

	// Arrow keys move between tabs (WAI-ARIA tabs pattern); only the selected tab is a Tab stop.
	const onKeyDown = (event) => {
		const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
		if (!step) return;
		event.preventDefault();
		const index = ADMIN_STOREFRONT_TABS.findIndex((tab) => tab.key === active);
		const next = ADMIN_STOREFRONT_TABS[(index + step + ADMIN_STOREFRONT_TABS.length) % ADMIN_STOREFRONT_TABS.length];
		select(next.key);
		document.getElementById(`admin-storefront-tab-${next.key}`)?.focus();
	};

	return (
		<div className="p-4 sm:p-6">
			<div role="tablist" aria-label="Mục quản lý gian hàng" onKeyDown={onKeyDown} className="-mx-4 sm:mx-0 mb-6 flex overflow-x-auto border-b border-gray-200 px-4 sm:px-0">
				{ADMIN_STOREFRONT_TABS.map((tab) => {
					const selected = tab.key === active;
					return (
						<button
							key={tab.key}
							type="button"
							role="tab"
							id={`admin-storefront-tab-${tab.key}`}
							aria-selected={selected}
							tabIndex={selected ? 0 : -1}
							aria-controls="admin-storefront-tabpanel"
							onClick={() => select(tab.key)}
							className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium transition-colors ${selected
								? 'border-primary-600 text-primary-700'
								: 'border-transparent text-gray-600 hover:border-gray-300 hover:text-gray-900'
								}`}
						>
							<i className={`fas ${tab.icon} mr-2`}></i>
							{tab.label}
						</button>
					);
				})}
			</div>

			<div role="tabpanel" tabIndex={0} id="admin-storefront-tabpanel" aria-labelledby={`admin-storefront-tab-${active}`}>
				{active === 'email-lists' ? <EmailListManagement /> : <StorefrontManagement />}
			</div>
		</div>
	);
};

export default StorefrontAdminPage;
