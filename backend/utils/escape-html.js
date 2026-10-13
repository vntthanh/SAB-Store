const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes text for HTML element content and quoted attribute values; null/undefined become ''. */
function escapeHtml(value) {
	return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

module.exports = { escapeHtml };
