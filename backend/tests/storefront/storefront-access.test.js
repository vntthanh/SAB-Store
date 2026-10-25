/**
 * The access rules of one storefront, as pure decisions: the rule lookup is the only
 * thing replaced, so every branch of view versus order is visible here.
 */
const data = require('../../data');
const {
	StorefrontAccessError, resolveViewer, isStaff, canView, canOrder, assertCanView, assertCanOrder, describeAccess, sendAccessError
} = require('../../services/storefront-access');
const { ERROR_CODES } = require('../../constants/errorCodes');

const storefront = (overrides = {}) => ({
	_id: '018f0000-0000-7000-8000-000000000001', slug: 'shop', name: 'Shop', visibility: 'PRIVATE', isActive: true, ...overrides
});
const viewerOf = (overrides = {}) => ({ id: 'u1', email: 'a@b.vn', emailVerified: true, role: 'customer', ...overrides });
const PUBLIC_SHOP = storefront({ visibility: 'PUBLIC' });
const INACTIVE_PUBLIC = storefront({ visibility: 'PUBLIC', isActive: false });
const INACTIVE_PRIVATE = storefront({ isActive: false });

describe('storefront access', () => {
	let admits;

	beforeEach(() => {
		admits = vi.spyOn(data.storefronts, 'viewerCanAccess').mockResolvedValue(false);
	});
	afterEach(() => vi.restoreAllMocks());

	describe('isStaff', () => {
		it.each([
			['admin', true],
			['customer,seller', true],
			['customer', false],
			[undefined, false]
		])('role %j -> %s', (role, expected) => {
			expect(isStaff(viewerOf({ role }))).toBe(expected);
		});

		it('is false for no viewer', () => {
			expect(isStaff(null)).toBe(false);
		});
	});

	describe('resolveViewer', () => {
		it('returns the viewer the optional middleware already set, null included', async () => {
			const viewer = viewerOf();

			expect(await resolveViewer({ viewer })).toBe(viewer);
			expect(await resolveViewer({ viewer: null })).toBeNull();
		});
	});

	describe('canView', () => {
		it.each([
			['public, anonymous', PUBLIC_SHOP, null, false, true],
			['private, anonymous', storefront(), null, false, false],
			['private, admitted and verified', storefront(), viewerOf(), true, true],
			['private, admitted but unverified', storefront(), viewerOf({ emailVerified: false }), true, false],
			['private, verified but not admitted', storefront(), viewerOf(), false, false],
			['private, admin without a rule', storefront(), viewerOf({ role: 'admin' }), false, true],
			['private, seller without a rule', storefront(), viewerOf({ role: 'seller' }), false, true],
			['inactive public, customer', INACTIVE_PUBLIC, viewerOf(), true, false],
			['inactive private, admitted customer', INACTIVE_PRIVATE, viewerOf(), true, false],
			['inactive, admin', INACTIVE_PRIVATE, viewerOf({ role: 'admin' }), false, true],
			['no storefront, admin', null, viewerOf({ role: 'admin' }), false, false]
		])('%s', async (_label, shop, viewer, admitted, expected) => {
			admits.mockResolvedValue(admitted);

			expect(await canView(shop, viewer)).toBe(expected);
		});

		it('passes the transaction to the rule lookup', async () => {
			const tx = {};
			admits.mockResolvedValue(true);

			await canView(storefront(), viewerOf(), tx);

			expect(admits).toHaveBeenCalledWith(storefront()._id, 'a@b.vn', tx);
		});
	});

	describe('canOrder', () => {
		it.each([
			['public, anonymous', PUBLIC_SHOP, null, false, true],
			['public, admin', PUBLIC_SHOP, viewerOf({ role: 'admin' }), false, true],
			['private, admitted and verified', storefront(), viewerOf(), true, true],
			['private, admitted but unverified', storefront(), viewerOf({ emailVerified: false }), true, false],
			['private, not admitted', storefront(), viewerOf(), false, false],
			['private, anonymous', storefront(), null, false, false],
			['private, admin not admitted: no staff bypass', storefront(), viewerOf({ role: 'admin' }), false, false],
			['private, seller not admitted: no staff bypass', storefront(), viewerOf({ role: 'seller' }), false, false],
			['private, admin whose email is admitted', storefront(), viewerOf({ role: 'admin' }), true, true],
			['inactive public', INACTIVE_PUBLIC, viewerOf(), true, false],
			['inactive private, admitted', INACTIVE_PRIVATE, viewerOf(), true, false],
			['no storefront', null, viewerOf(), true, false]
		])('%s', async (_label, shop, viewer, admitted, expected) => {
			admits.mockResolvedValue(admitted);

			expect(await canOrder(shop, viewer)).toBe(expected);
		});
	});

	describe('assertCanView', () => {
		const codeOf = async (shop, viewer) => {
			try {
				await assertCanView(shop, viewer);
				return null;
			} catch (error) {
				expect(error).toBeInstanceOf(StorefrontAccessError);
				return error;
			}
		};

		it('passes where canView does', async () => {
			expect(await codeOf(PUBLIC_SHOP, null)).toBeNull();
			expect(await codeOf(storefront(), viewerOf({ role: 'seller' }))).toBeNull();
		});

		it.each([
			['a missing storefront', null, viewerOf()],
			['an inactive one, for a customer', INACTIVE_PUBLIC, viewerOf()],
			['an inactive one, for an anonymous visitor', INACTIVE_PRIVATE, null]
		])('says not found for %s, naming nothing', async (_label, shop, viewer) => {
			const error = await codeOf(shop, viewer);

			expect(error.code).toBe(ERROR_CODES.STOREFRONT_NOT_FOUND);
			expect(error.storefront).toBeUndefined();
		});

		it('asks an anonymous visitor to sign in, naming the storefront', async () => {
			const error = await codeOf(storefront(), null);

			expect(error.code).toBe(ERROR_CODES.STOREFRONT_LOGIN_REQUIRED);
			expect(error.storefront).toEqual({ slug: 'shop', name: 'Shop' });
		});

		it.each([
			['not admitted', viewerOf()],
			['unverified', viewerOf({ emailVerified: false })]
		])('forbids a signed-in visitor who is %s', async (_label, viewer) => {
			const error = await codeOf(storefront(), viewer);

			expect(error.code).toBe(ERROR_CODES.STOREFRONT_FORBIDDEN);
			expect(error.storefront).toEqual({ slug: 'shop', name: 'Shop' });
		});

		it('lets staff preview an inactive storefront', async () => {
			expect(await codeOf(INACTIVE_PRIVATE, viewerOf({ role: 'admin' }))).toBeNull();
		});
	});

	describe('assertCanOrder', () => {
		const codeOf = async (shop, viewer) => {
			try {
				await assertCanOrder(shop, viewer);
				return null;
			} catch (error) {
				return error;
			}
		};

		it('passes for a public storefront and for an admitted verified email', async () => {
			admits.mockResolvedValue(true);

			expect(await codeOf(PUBLIC_SHOP, null)).toBeNull();
			expect(await codeOf(storefront(), viewerOf())).toBeNull();
		});

		it('says not found for an inactive storefront even to staff', async () => {
			const error = await codeOf(INACTIVE_PRIVATE, viewerOf({ role: 'admin' }));

			expect(error.code).toBe(ERROR_CODES.STOREFRONT_NOT_FOUND);
		});

		it('asks an anonymous visitor to sign in', async () => {
			expect((await codeOf(storefront(), null)).code).toBe(ERROR_CODES.STOREFRONT_LOGIN_REQUIRED);
		});

		it.each([
			['a customer who is not admitted', viewerOf()],
			['an admin who is not admitted', viewerOf({ role: 'admin' })],
			['a seller who is not admitted', viewerOf({ role: 'seller' })]
		])('refuses %s with the order code', async (_label, viewer) => {
			const error = await codeOf(storefront(), viewer);

			expect(error.code).toBe(ERROR_CODES.STOREFRONT_ORDER_FORBIDDEN);
			expect(error.storefront).toEqual({ slug: 'shop', name: 'Shop' });
		});
	});

	describe('describeAccess', () => {
		it('answers a whole list with one rule query', async () => {
			const open = PUBLIC_SHOP;
			const admitted = storefront({ _id: 'a', slug: 'a' });
			const closed = storefront({ _id: 'b', slug: 'b' });
			const accessible = vi.spyOn(data.storefronts, 'accessibleIds').mockResolvedValue(['a']);

			const access = await describeAccess([open, admitted, closed], viewerOf());

			expect(accessible).toHaveBeenCalledTimes(1);
			expect(access.get(open._id)).toEqual({ canView: true, canOrder: true });
			expect(access.get('a')).toEqual({ canView: true, canOrder: true });
			expect(access.get('b')).toEqual({ canView: false, canOrder: false });
		});

		it('lets staff view but not order a private storefront', async () => {
			vi.spyOn(data.storefronts, 'accessibleIds').mockResolvedValue([]);

			const access = await describeAccess([storefront({ _id: 'b' })], viewerOf({ role: 'seller' }));

			expect(access.get('b')).toEqual({ canView: true, canOrder: false });
		});

		it('grants nothing to an anonymous or unverified viewer, whatever the rules say', async () => {
			vi.spyOn(data.storefronts, 'accessibleIds').mockResolvedValue(['b']);

			const anonymous = await describeAccess([storefront({ _id: 'b' })], null);
			const unverified = await describeAccess([storefront({ _id: 'b' })], viewerOf({ emailVerified: false }));

			expect(anonymous.get('b')).toEqual({ canView: false, canOrder: false });
			expect(unverified.get('b')).toEqual({ canView: false, canOrder: false });
		});
	});

	describe('sendAccessError', () => {
		const reply = (error) => {
			const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
			sendAccessError(res, error);
			return { status: res.status.mock.calls[0][0], body: res.json.mock.calls[0][0] };
		};

		it.each([
			[ERROR_CODES.STOREFRONT_NOT_FOUND, 404],
			[ERROR_CODES.STOREFRONT_LOGIN_REQUIRED, 401],
			[ERROR_CODES.STOREFRONT_FORBIDDEN, 403],
			[ERROR_CODES.STOREFRONT_ORDER_FORBIDDEN, 403]
		])('maps %s to %s with its Vietnamese message', (code, status) => {
			const { status: sent, body } = reply(new StorefrontAccessError(code));

			expect(sent).toBe(status);
			expect(body).toMatchObject({ success: false, code });
			expect(body.message).toEqual(expect.any(String));
			expect(body).not.toHaveProperty('storefront');
		});

		it('names the storefront when the error carries it', () => {
			const { body } = reply(new StorefrontAccessError(ERROR_CODES.STOREFRONT_FORBIDDEN, storefront({ description: 'secret' })));

			expect(body.storefront).toEqual({ slug: 'shop', name: 'Shop' });
		});
	});
});
