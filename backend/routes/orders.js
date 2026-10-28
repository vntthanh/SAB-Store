const express = require('express');
const { validateOrder, trimText } = require('../middleware/validation');
const { generateOrderCode } = require('../utils/helpers');
const { sendOrderMail } = require('../services/mailer');
const { generateOrderPaymentQR, formatOrderPaymentDescription } = require('../utils/paymentHelper');
const { computeOrderPricing, assertExpectedTotal, pricingErrorBody, PricingError } = require('../services/pricing');
const { recordOrderMovements } = require('../services/stock');
const { enqueueMovements } = require('../services/stock-ledger');
const { orders, storefronts, withTransaction } = require('../data');
const { StorefrontAccessError, resolveViewer, assertCanOrder, assertCanOrderCart, sendAccessError } = require('../services/storefront-access');
const { RecordValidationError, isDuplicateKeyOn } = require('../data/errors');
const { gated } = require('../services/write-gate');
const { logEvent, orderCreatedFields } = require('../utils/log-event');
const ErrorLogger = require('../utils/errorLogger');
const router = express.Router();

const MAX_ORDER_CODE_ATTEMPTS = 10;

/**
 * @route   POST /api/orders
 * @desc    Create a new order
 * @access  Public
 */
router.post('/', validateOrder, gated(async (req, res) => {
	try {
		const { items, expectedTotal } = req.body;
		// Validation checks the trimmed text but does not rewrite the request, so
		// what is stored and forwarded is trimmed here.
		const studentId = trimText(req.body.studentId);
		const fullName = trimText(req.body.fullName);
		const clientEmail = trimText(req.body.email);
		const phoneNumber = trimText(req.body.phoneNumber);
		const additionalNote = trimText(req.body.additionalNote);

		// Price, order and stock movements are one transaction: nothing the client
		// sends about price is read (expectedTotal is only compared — a mismatch
		// means the price moved since the customer saw it), and a failure at any
		// step leaves no order and no movement behind. Stock is never checked, so
		// an order for a product that has none is accepted.
		//
		// A duplicate orderCode (another order already has it, or two requests drew
		// the same fresh code) aborts the transaction, so the whole transaction
		// runs again with a new code.
		// The session is read before the transaction opens: resolving it is not
		// part of the order and must not run inside a retryable transaction.
		const viewer = await resolveViewer(req);

		let created;
		for (let attempt = 1; !created; attempt++) {
			try {
				created = await withTransaction(async (tx) => {
					// Before pricing: its errors name products and prices, which a viewer
					// without access to the storefront must not learn.
					await assertCanOrderCart(items, viewer, tx);
					const pricing = await computeOrderPricing(items, {
						channel: 'online',
						session: tx,
						enforceQuantityLimits: true
					});
					assertExpectedTotal(expectedTotal, pricing.totalAmount);

					// Access is decided here, in the order's own transaction and from the
					// rules as they are now, so a rule revoked since the page loaded blocks
					// this very order. A null storefront (rollback store) has no rules.
					let email = clientEmail;
					if (pricing.storefrontId !== null) {
						const storefront = await storefronts.findById(pricing.storefrontId, tx);
						await assertCanOrder(storefront, viewer, tx);
						// The session's verified address is what the whitelist admitted; the
						// address typed into the form could be anyone's.
						if (storefront.visibility === 'PRIVATE') email = viewer.email;
					}

					const order = await orders.create({
						orderCode: generateOrderCode(),
						studentId,
						fullName,
						email,
						phoneNumber,
						additionalNote,
						storefrontId: pricing.storefrontId,
						items: pricing.orderItems,
						totalAmount: pricing.totalAmount,
						status: 'confirmed',
						stockDeducted: true,
						lastUpdatedBy: 'system',
						comboInfo: pricing.comboInfo,
						statusHistory: [
							{
								status: 'confirmed',
								updatedBy: 'system',
								updatedAt: new Date(),
								note: 'Đơn hàng được tạo từ hệ thống'
							}
						]
					}, tx);

					const movements = await recordOrderMovements({
						orderId: order._id,
						items: pricing.orderItems,
						type: 'order',
						keyTag: 'create',
						createdBy: 'system',
						reason: `Đơn hàng ${order.orderCode}`
					}, { tx });

					return { order, pricing, movements, email };
				});
			} catch (error) {
				if (error instanceof StorefrontAccessError) return sendAccessError(res, error);
				if (error instanceof PricingError) {
					console.error('❌ Pricing rejected order:', error.code, error.details);
					return res.status(error.httpStatus).json(pricingErrorBody(error));
				}
				const codeCollision = isDuplicateKeyOn(error, 'orderCode');
				if (codeCollision && attempt < MAX_ORDER_CODE_ATTEMPTS) {
					console.warn('⚠️ orderCode collision, retrying transaction');
					continue;
				}
				if (codeCollision) {
					console.error('❌ Failed to create order after', MAX_ORDER_CODE_ATTEMPTS, 'attempts (orderCode collisions)');
					return res.status(500).json({
						success: false,
						message: 'Không thể tạo mã đơn hàng duy nhất'
					});
				}
				throw error;
			}
		}

		const { order, pricing: { totalAmount, orderItems, comboInfo }, movements, email } = created;

		// The order is durable; only now may anything leave the transaction.
		logEvent('order.created', orderCreatedFields({ channel: 'online', orderItems, totalAmount, comboInfo }));
		await enqueueMovements(movements);

		// Generate payment QR URL and description
		let qrUrl = null;
		let paymentDescription = null;
		try {
			qrUrl = await generateOrderPaymentQR(totalAmount, order.orderCode, studentId, fullName);
			paymentDescription = await formatOrderPaymentDescription(order.orderCode, studentId, fullName);
		} catch (qrError) {
			console.error('❌ Failed to generate QR URL:', qrError.message);
		}

		// Confirmation mail to the customer; the mailer skips it unless an admin turned it on.
		setImmediate(() => {
			sendOrderMail('order_created', {
				orderCode: order.orderCode,
				studentId,
				fullName,
				email,
				phoneNumber,
				additionalNote,
				createdAt: order.createdAt,
				items: orderItems,
				totalAmount,
				paymentDescription
			});
		});

		res.status(201).json({
			success: true,
			message: 'Đơn hàng đã được tạo thành công',
			data: {
				orderCode: order.orderCode,
				totalAmount,
				status: 'confirmed',
				createdAt: order.createdAt,
				comboInfo,
				qrUrl,
				paymentDescription
			}
		});

	} catch (error) {
		// Not the request body: it holds the customer's note and contact details.
		ErrorLogger.log(error, { route: 'POST /orders' });

		// More specific error handling
		if (error instanceof RecordValidationError) {
			console.error('❌ Validation error fields:', error.fieldErrors.map(entry => entry.field));
			return res.status(400).json({
				success: false,
				message: 'Dữ liệu đơn hàng không hợp lệ',
				errors: error.fieldErrors.map(entry => entry.message)
			});
		}

		if (error.name === 'MongoError' || error.name === 'MongoServerError') {
			console.error('Database error creating order (details logged above)');
			return res.status(500).json({
				success: false,
				message: 'Lỗi cơ sở dữ liệu'
			});
		}

		res.status(500).json({
			success: false,
			message: 'Lỗi server khi tạo đơn hàng',
			...(process.env.NODE_ENV === 'development' && { debug: error.message })
		});
	}
}));

/**
 * @route   GET /api/orders/:orderCode
 * @desc    Get order by order code (for customer tracking)
 * @access  Public
 */
router.get('/:orderCode', async (req, res) => {
	try {
		const { orderCode } = req.params;

		const order = await orders.findByCode(orderCode.toUpperCase());

		if (!order) {
			return res.status(404).json({
				success: false,
				message: 'Không tìm thấy đơn hàng với mã này'
			});
		}

		// Generate QR code URL and payment description. studentId/fullName are
		// needed here to build them but must not leak as top-level response
		// fields below (P1-7).
		//
		// Accepted trade-off (not fixed further): studentId and a
		// name-derived short name are still embedded verbatim inside
		// paymentDescription/qrUrl's addInfo, because bank-transfer
		// reconciliation needs the student id in the transfer content to
		// match a payment to a student. P1-7 only stops studentId/fullName
		// from appearing as their own top-level fields — anyone holding an
		// order code can still read the student id (and initials+surname)
		// out of paymentDescription/qrUrl. This is accepted, not an oversight.
		let qrUrl = null;
		let paymentDescription = null;
		try {
			qrUrl = await generateOrderPaymentQR(
				order.totalAmount,
				order.orderCode,
				order.studentId,
				order.fullName
			);
			paymentDescription = await formatOrderPaymentDescription(
				order.orderCode,
				order.studentId,
				order.fullName
			);
		} catch (error) {
			console.error('Error generating payment info:', error.name);
		}

		// Return order information including payment details. studentId and
		// fullName are intentionally excluded as top-level fields — see the
		// comment above about paymentDescription/qrUrl still carrying the
		// student id by design.
		res.json({
			success: true,
			data: {
				orderCode: order.orderCode,
				status: order.status,
				totalAmount: order.totalAmount,
				createdAt: order.createdAt,
				statusUpdatedAt: order.statusUpdatedAt,
				qrUrl: qrUrl,
				paymentDescription: paymentDescription,
				items: order.items.map(item => ({
					productName: item.productName,
					...(item.variantLabel && { variantLabel: item.variantLabel }),
					quantity: item.quantity,
					price: item.price
				}))
			}
		});

	} catch (error) {
		console.error('Error fetching order:', error.name);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi lấy thông tin đơn hàng'
		});
	}
});

module.exports = router;
