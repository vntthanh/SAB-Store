/**
 * Folding products that were kept apart as stand-ins for one option (one product
 * per size, say) into a single product with that option, inside one transaction.
 *
 * The target is one of the sources and keeps its id and public code; its default
 * variant becomes the variant of its own value. Every other source becomes a new
 * variant of the target: its stock moves there through a pair of `adjust`
 * movements (out of the source, into the variant), its order lines are pointed at
 * the target and the variant (the orders themselves, codes and totals included,
 * are untouched), and the source product is switched off, never deleted, so its
 * movements stay readable.
 */
const { RecordValidationError } = require('../errors');
const { recordId } = require('./rules');
const { lockVariants, saveVariantSetup } = require('./product-variants');

const fail = (message) => {
	throw new RecordValidationError([{ field: 'merge', message }]);
};

/**
 * @param {{targetId: string, name: string, optionName: string, values: string[], salesChannel: string,
 *          sources: Array<{productId: string, value: string}>}} merge `values` gives the option's
 *        order and may hold values no source has; the target's own value must come first
 * @param {object} tx
 * @param {(movement: object, opts: {tx: object}) => Promise<object>} recordMovement the stock ledger's
 * @returns {Promise<{targetId: string, variants: Array<{value: string, variantId: string, fromCode: string|null,
 *          stockMoved: number, orderLines: number}>, retiredCodes: string[], movements: object[]}>}
 * @throws {RecordValidationError} a source that is missing, already merged, has options, pending
 *         stock, or another category or storefront; values that do not fit the sources
 */
async function mergeIntoVariants(merge, tx, recordMovement) {
	const targetId = recordId(merge.targetId);
	const sources = merge.sources.map((source) => ({ ...source, productId: recordId(source.productId) }));
	const target = sources.find((source) => source.productId === targetId);
	if (!target) fail('Sản phẩm đích phải là một trong các sản phẩm nguồn');
	if (merge.values[0] !== target.value) fail('Giá trị của sản phẩm đích phải đứng đầu danh sách giá trị');
	if (new Set(merge.values).size !== merge.values.length) fail('Giá trị bị trùng');
	if (new Set(sources.map((source) => source.value)).size !== sources.length) fail('Hai sản phẩm nguồn cùng một giá trị');
	if (sources.some((source) => !merge.values.includes(source.value))) fail('Giá trị của một sản phẩm nguồn không có trong danh sách');

	// Every source's variants, then the rows: the stock ledger's lock order.
	for (const id of [...sources.map((source) => source.productId)].sort()) await lockVariants(id, tx);
	const rows = await tx.product.findMany({
		where: { id: { in: sources.map((source) => source.productId) } },
		include: { variants: true, options: true }
	});
	const byId = new Map(rows.map((row) => [row.id, row]));
	const targetRow = byId.get(targetId);
	for (const source of sources) {
		const row = byId.get(source.productId);
		if (!row) fail(`Không tìm thấy sản phẩm ${source.productId}`);
		if (!row.isActive || !row.available) fail(`Sản phẩm ${row.publicCode} đã tắt (đã gộp trước đó?)`);
		if (row.options.length > 0 || row.variants.length !== 1) fail(`Sản phẩm ${row.publicCode} đã có phân loại`);
		if (row.category !== targetRow.category || row.storefrontId !== targetRow.storefrontId) {
			fail(`Sản phẩm ${row.publicCode} khác danh mục hoặc gian hàng với sản phẩm đích`);
		}
	}
	const pending = await tx.stockMovement.count({ where: { productId: { in: [...byId.keys()] }, status: 'pending' } });
	if (pending > 0) fail('Còn biến động kho chưa áp dụng; chờ worker xử lý rồi chạy lại');

	const images = [...new Set(sources.flatMap((source) => byId.get(source.productId).images))];
	if (images.length > 9) fail('Quá 9 ảnh sau khi gộp');
	const valueSource = new Map(sources.map((source) => [source.value, byId.get(source.productId)]));
	const variantImage = (value) => {
		const cover = valueSource.get(value)?.images[0];
		return cover && cover !== images[0] ? cover : null;
	};

	await tx.product.update({
		where: { id: targetId },
		data: { name: merge.name, salesChannel: merge.salesChannel, images, imageUrl: images[0] ?? '/fallback-product.png' }
	});
	await saveVariantSetup(targetId, {
		options: [{ name: merge.optionName, values: merge.values }],
		variants: merge.values.map((value) => ({ optionValues: [value], price: null, sku: null, imageUrl: variantImage(value), isActive: true }))
	}, tx);
	const variantByValue = new Map((await tx.productVariant.findMany({ where: { productId: targetId } }))
		.map((variant) => [variant.optionValues[0], variant]));

	const report = [];
	const movements = [];
	for (const value of merge.values) {
		const row = valueSource.get(value);
		const variant = variantByValue.get(value);
		const entry = { value, variantId: variant.id, fromCode: row ? row.publicCode : null, stockMoved: 0, orderLines: 0 };
		if (row) {
			const { count } = await tx.orderItem.updateMany({
				where: { productId: row.id },
				data: { productId: targetId, variantId: variant.id, variantLabel: value, productName: merge.name }
			});
			entry.orderLines = count;
			const stock = row.variants[0].stockQuantity;
			if (row.id !== targetId && stock !== 0) {
				const reason = `Gộp vào ${targetRow.publicCode}`;
				movements.push(await recordMovement({ productId: row.id, variantId: row.variants[0].id, type: 'adjust', delta: -stock, reason, createdBy: 'merge', idempotencyKey: `merge:${targetId}:${row.id}:out` }, { tx }));
				movements.push(await recordMovement({ productId: targetId, variantId: variant.id, type: 'adjust', delta: stock, reason, createdBy: 'merge', idempotencyKey: `merge:${targetId}:${row.id}:in` }, { tx }));
				entry.stockMoved = stock;
			}
		}
		report.push(entry);
	}

	const retired = sources.filter((source) => source.productId !== targetId).map((source) => byId.get(source.productId));
	await tx.product.updateMany({ where: { id: { in: retired.map((row) => row.id) } }, data: { available: false, isActive: false } });
	return { targetId, variants: report, retiredCodes: retired.map((row) => row.publicCode), movements };
}

module.exports = { mergeIntoVariants };
