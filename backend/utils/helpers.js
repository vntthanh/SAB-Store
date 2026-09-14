/**
 * Generate a random order code with 5 characters
 * Only uppercase letters and numbers 2-9 (no 0, 1, O, I to avoid confusion)
 * @returns {string} 5-character order code
 */
function generateOrderCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let result = '';
  
  for (let i = 0; i < 5; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  return result;
}

/**
 * Format Vietnamese currency
 * @param {number} amount 
 * @returns {string} Formatted currency string
 */
function formatCurrency(amount) {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND'
  }).format(amount);
}

/**
 * Format date for Vietnamese locale
 * @param {Date} date 
 * @returns {string} Formatted date string
 */
function formatDate(date) {
  return new Intl.DateTimeFormat('vi-VN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(date));
}

/**
 * Validate email format
 * @param {string} email 
 * @returns {boolean}
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Calculate total amount from order items
 * @param {Array} items 
 * @returns {number}
 */
function calculateTotal(items) {
  return items.reduce((total, item) => {
    return total + (item.price * item.quantity);
  }, 0);
}

/**
 * Generate pagination info
 * @param {number} page 
 * @param {number} limit 
 * @param {number} total 
 * @returns {Object}
 */
function getPaginationInfo(page, limit, total) {
  const totalPages = Math.ceil(total / limit);
  const hasNext = page < totalPages;
  const hasPrev = page > 1;
  
  return {
    currentPage: page,
    totalPages,
    totalItems: total,
    itemsPerPage: limit,
    hasNext,
    hasPrev
  };
}

module.exports = {
  generateOrderCode,
  formatCurrency,
  formatDate,
  isValidEmail,
  calculateTotal,
  getPaginationInfo
};
