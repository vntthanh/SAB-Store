// Mirrors backend/models/Product.js SALES_CHANNELS; the server is the authority.
export const SALES_CHANNELS = ['all', 'online', 'offline'];

export const SALES_CHANNEL_LABELS = {
	all: 'Cả online và tại quầy',
	online: 'Chỉ online',
	offline: 'Chỉ tại quầy'
};

// Records created before the field existed have no salesChannel and sell everywhere.
export const normalizeSalesChannel = (value) =>
	SALES_CHANNELS.includes(value) ? value : 'all';
