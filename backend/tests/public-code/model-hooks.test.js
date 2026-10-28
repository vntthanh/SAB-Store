const publicCode = require('../../utils/public-code');
const { makeProduct, makeCombo } = require('../helpers/factories');

const { PUBLIC_CODE_PATTERN } = publicCode;

describe('publicCode + slug on new documents', () => {
	it('gives a new product and a new combo a code and a slug', async () => {
		const product = await makeProduct({ name: 'Móc khoá SAB', price: 1000, category: 'general' });
		const combo = await makeCombo({ name: 'Combo Quà Tặng' });

		expect(product.publicCode).toMatch(PUBLIC_CODE_PATTERN);
		expect(product.slug).toBe('moc-khoa-sab');
		expect(combo.publicCode).toMatch(PUBLIC_CODE_PATTERN);
		expect(combo.slug).toBe('combo-qua-tang');
	});
});
