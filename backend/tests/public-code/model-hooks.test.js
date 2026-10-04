const publicCode = require('../../utils/public-code');
const Product = require('../../models/Product');
const Combo = require('../../models/Combo');
const { makeProduct, makeCombo, makeLegacyProduct } = require('../helpers/factories');

const { PUBLIC_CODE_PATTERN, makeSlug } = publicCode;

beforeAll(() => Promise.all([Product.init(), Combo.init()]));

describe('publicCode + slug on new documents', () => {
	it('gives a new product and a new combo a code and a slug', async () => {
		const product = await Product.create({ name: 'Móc khoá SAB', price: 1000, category: 'general' });
		const combo = await makeCombo({ name: 'Combo Quà Tặng' });

		expect(product.publicCode).toMatch(PUBLIC_CODE_PATTERN);
		expect(product.slug).toBe('moc-khoa-sab');
		expect(combo.publicCode).toMatch(PUBLIC_CODE_PATTERN);
		expect(combo.slug).toBe('combo-qua-tang');
	});

	it('rejects a malformed explicit code', async () => {
		await expect(Product.create({ name: 'x', price: 1, category: 'g', publicCode: 'nope' })).rejects.toThrow();
	});
});

describe('slug follows the current name, the code never changes', () => {
	it('on save()', async () => {
		const product = await makeProduct({ name: 'Tên cũ' });
		const code = product.publicCode;

		product.name = 'Tên mới';
		await product.save();

		const stored = await Product.findById(product._id).lean();
		expect(stored.slug).toBe(makeSlug('Tên mới', code));
		expect(stored.publicCode).toBe(code);
	});

	it('on findByIdAndUpdate (the admin PUT path), top-level and $set forms', async () => {
		const product = await makeProduct({ name: 'Tên cũ' });
		const code = product.publicCode;

		await Product.findByIdAndUpdate(product._id, { name: 'Tên mới' }, { new: true, runValidators: true });
		expect((await Product.findById(product._id).lean()).slug).toBe('ten-moi');

		await Product.findByIdAndUpdate(product._id, { $set: { name: 'Tên khác nữa' } }, { new: true });
		const stored = await Product.findById(product._id).lean();
		expect(stored.slug).toBe('ten-khac-nua');
		expect(stored.publicCode).toBe(code);
	});

	it('on updateOne for a combo', async () => {
		const combo = await makeCombo({ name: 'Combo cũ' });

		await Combo.updateOne({ _id: combo._id }, { name: 'Combo mới' });

		expect((await Combo.findById(combo._id).lean()).slug).toBe('combo-moi');
	});

	it('leaves the slug alone when the update does not touch the name', async () => {
		const product = await makeProduct({ name: 'Giữ nguyên' });

		await Product.findByIdAndUpdate(product._id, { price: 5000 });

		expect((await Product.findById(product._id).lean()).slug).toBe('giu-nguyen');
	});

	it('ignores an attempt to overwrite the code through an update', async () => {
		const product = await makeProduct();

		await Product.findByIdAndUpdate(product._id, { publicCode: 'ZZZZZZZZ', price: 5000 });

		expect((await Product.findById(product._id).lean()).publicCode).toBe(product.publicCode);
	});
});

describe('documents written before public codes existed', () => {
	// publicCode is immutable, so a save cannot add it. This pins that fact so
	// nobody builds on the hook to heal old rows: the backfill does that.
	it('stay without a code after save()', async () => {
		const legacy = await makeLegacyProduct({ name: 'Cũ' });
		const doc = await Product.findById(legacy._id);

		doc.name = 'Cũ đổi tên';
		await doc.save();

		const raw = await Product.collection.findOne({ _id: legacy._id });
		expect(raw.name).toBe('Cũ đổi tên');
		expect(raw.publicCode).toBeUndefined();
		expect(raw.slug).toBeUndefined();
	});
});
