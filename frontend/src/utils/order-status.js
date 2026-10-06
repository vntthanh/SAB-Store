// Mirrors backend FINAL_ORDER_STATUSES: the server rejects status changes from
// these states (409 ORDER_FINAL); the UI only uses this to hide the controls.
const FINAL_ORDER_STATUSES = ['cancelled', 'delivered'];

export const isFinalOrderStatus = (status) => FINAL_ORDER_STATUSES.includes(status);

// Orders do not store their channel: counter sales are the offline channel.
export const getOrderChannel = (order) => (order.isDirectSale ? 'offline' : 'online');
