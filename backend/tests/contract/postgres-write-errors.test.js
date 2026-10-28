/**
 * What the postgres backend does with the errors a real Postgres raises. The
 * shapes come from the live server through Prisma, not from fixtures, because the
 * driver adapter's wording is what the translation depends on. Skipped on the
 * mongo backend, whose errors data/mongo/errors.js translates.
 */
const { v7: uuidv7 } = require('uuid');
const { DEFAULT_STOREFRONT_ID } = require('../../data/default-storefront');
const { DuplicateKeyError, RecordValidationError, InvalidIdError, isDuplicateKeyOn } = require('../../data/errors');

const POSTGRES = process.env.DATA_BACKEND === 'postgres';

describe.skipIf(!POSTGRES)('postgres translateWriteError', () => {
	let prisma;
	let translateWriteError;
	let stockLedger;

	beforeAll(() => {
		({ prisma } = require('../../lib/prisma'));
		({ translateWriteError } = require('../../data/postgres/errors'));
		({ stockLedger } = require('../../data'));
	});

	afterAll(async () => {
		await prisma.$disconnect();
	});

	const failure = (operation) => operation().then(
		() => { throw new Error('expected the operation to fail'); },
		(err) => err
	);
	const product = (overrides = {}) => ({ id: uuidv7(), name: 'p', price: 1, category: 'c', publicCode: uuidv7(), slug: 's', storefrontId: DEFAULT_STOREFRONT_ID, ...overrides });
	const movement = (overrides = {}) => ({ id: uuidv7(), productId: uuidv7(), variantId: uuidv7(), type: 'adjust', delta: 1, idempotencyKey: uuidv7(), ...overrides });

	it('turns a unique violation into a DuplicateKeyError naming the record field', async () => {
		await prisma.stockMovement.create({ data: movement({ idempotencyKey: 'taken' }) });
		const raw = await failure(() => prisma.stockMovement.create({ data: movement({ idempotencyKey: 'taken' }) }));

		const error = translateWriteError(raw);

		expect(error).toBeInstanceOf(DuplicateKeyError);
		expect(error.fields).toEqual(['idempotencyKey']);
		expect(isDuplicateKeyOn(error, 'idempotencyKey')).toBe(true);
		expect(error.cause).toBe(raw);
	});

	it('names publicCode for the product code column', async () => {
		await prisma.product.create({ data: product({ publicCode: 'SAB-1' }) });
		const raw = await failure(() => prisma.product.create({ data: product({ publicCode: 'SAB-1' }) }));

		expect(translateWriteError(raw).fields).toEqual(['publicCode']);
	});

	it('turns a failed CHECK into a RecordValidationError on the column', async () => {
		const raw = await failure(() => prisma.product.create({ data: product({ price: -5 }) }));

		const error = translateWriteError(raw);

		expect(error).toBeInstanceOf(RecordValidationError);
		expect(error.fieldErrors.map((entry) => entry.field)).toEqual(['price']);
	});

	it('reports a CHECK raised by raw SQL the same way', async () => {
		const id = uuidv7();
		const raw = await failure(() => prisma.$executeRaw`
			INSERT INTO products (id, name, price, category, public_code, slug, storefront_id, min_order_quantity, updated_at)
			VALUES (${id}::uuid, 'p', 1, 'c', ${uuidv7()}, 's', ${DEFAULT_STOREFRONT_ID}::uuid, 0, now())`);

		const error = translateWriteError(raw);

		expect(error).toBeInstanceOf(RecordValidationError);
		expect(error.fieldErrors.map((entry) => entry.field)).toEqual(['minOrderQuantity']);
	});

	it('turns a value that is too long into a RecordValidationError, naming "value" because the driver does not say which column', async () => {
		const raw = await failure(() => prisma.order.create({ data: { orderCode: 'W'.repeat(11), totalAmount: 1 } }));

		const error = translateWriteError(raw);

		expect(error).toBeInstanceOf(RecordValidationError);
		expect(error.fieldErrors.map((entry) => entry.field)).toEqual(['value']);
	});

	it('turns a value that is not a uuid into an InvalidIdError carrying the value', async () => {
		const viaClient = await failure(() => prisma.stockMovement.findUnique({ where: { id: 'nope' } }));
		const viaSql = await failure(() => prisma.$queryRaw`SELECT ${'nope'}::uuid`);

		for (const raw of [viaClient, viaSql]) {
			const error = translateWriteError(raw);
			expect(error).toBeInstanceOf(InvalidIdError);
			expect(error.value).toBe('nope');
		}
	});

	it('refuses a malformed id from a repository before querying', async () => {
		await expect(stockLedger.claimForApply('nope')).rejects.toBeInstanceOf(InvalidIdError);
		await expect(stockLedger.countPendingByProduct(['nope'])).rejects.toBeInstanceOf(InvalidIdError);
	});

	it('leaves errors it does not know untouched, so a deadlock keeps its retry code', () => {
		const deadlock = Object.assign(new Error('deadlock'), { code: 'P2034' });
		const plain = new Error('boom');

		expect(translateWriteError(deadlock)).toBe(deadlock);
		expect(translateWriteError(plain)).toBe(plain);
		expect(translateWriteError(null)).toBeNull();
		expect(translateWriteError('text')).toBe('text');
	});
});
