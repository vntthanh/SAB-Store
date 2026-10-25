import React from 'react';

// Empty value = every storefront. Shared by the product, combo and order lists so the filter
// looks and sends `storefrontId` the same way everywhere.
const StorefrontFilter = ({ storefronts, value, onChange, disabled = false, className = 'w-full sm:w-52' }) => (
	<select
		aria-label="Lọc theo gian hàng"
		value={value}
		onChange={(e) => onChange(e.target.value)}
		disabled={disabled}
		className={`form-input ${className}`}
	>
		<option value="">Tất cả gian hàng</option>
		{storefronts.map((storefront) => (
			<option key={storefront._id} value={storefront._id}>{storefront.name}</option>
		))}
	</select>
);

export default StorefrontFilter;
