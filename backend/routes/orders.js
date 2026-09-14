const express = require('express');
const Order = require('../models/Order');
const { validateOrder } = require('../middleware/validation');
const { generateOrderCode } = require('../utils/helpers');
const { sendOrderToAppScript } = require('../utils/appscript');
const { generateOrderPaymentQR, formatOrderPaymentDescription } = require('../utils/paymentHelper');
const { computeOrderPricing, PricingError } = require('../services/pricing');
const router = express.Router();

// Vietnamese messages for each PricingError code. All are 400s — see
// PricingError's own doc comment for why (each describes a cart the caller
// could have validated before sending, never a server fault).
const PRICING_ERROR_MESSAGES = {
	EMPTY_CART: 'Danh sách sản phẩm không hợp lệ',
	PRODUCT_UNAVAILABLE: 'Một hoặc nhiều sản phẩm không tồn tại hoặc không khả dụng',
	INVALID_QUANTITY: 'Số lượng sản phẩm không hợp lệ',
};

/**
 * @route   POST /api/orders
 * @desc    Create a new order
 * @access  Public
 */
router.post('/', validateOrder, async (req, res) => {
	try {
		console.log('📝 Order creation started:', {
			timestamp: new Date().toISOString(),
			body: { ...req.body, items: req.body.items?.length ? `${req.body.items.length} items` : 'no items' }
		});

		const { studentId, fullName, email, phoneNumber, additionalNote, items, optimalPricing, useOptimalPricing = false } = req.body;

		console.log('🔍 Processing items:', items.map(item => ({ productId: item.productId, quantity: item.quantity })));

		// totalAmount, orderItems and comboInfo always come from the DB via
		// computeOrderPricing — nothing the client sends about price is read.
		// useOptimalPricing/optimalPricing are still accepted below so an
		// older client doesn't get a hard validation error, but they only
		// feed a mismatch warning, never the stored total.
		let totalAmount, orderItems, comboInfo;
		try {
			({ totalAmount, orderItems, comboInfo } = await computeOrderPricing(items));
		} catch (pricingError) {
			if (pricingError instanceof PricingError) {
				console.error('❌ Pricing rejected order:', pricingError.code, pricingError.details);
				return res.status(pricingError.httpStatus).json({
					success: false,
					message: PRICING_ERROR_MESSAGES[pricingError.code] || 'Không thể tính giá đơn hàng',
					...(Object.keys(pricingError.details || {}).length > 0 && { details: pricingError.details })
				});
			}
			throw pricingError;
		}

		if (useOptimalPricing && optimalPricing && typeof optimalPricing?.summary?.finalTotal === 'number'
			&& optimalPricing.summary.finalTotal !== totalAmount) {
			// Either a stale client still computing its own total, or someone
			// probing whether the server still trusts it. Not an error.
			console.warn('⚠️ Client-submitted total disagrees with server-computed total', {
				clientTotal: optimalPricing.summary.finalTotal,
				serverTotal: totalAmount
			});
		}

		console.log('💾 Creating order in database...');
		// Generate a unique order code and create the order. Retries cover two
		// distinct collision windows: generateOrderCode() picking a code another
		// order already has (checked below via findOne) and the rarer race
		// where two requests pick the same fresh code between that check and
		// the insert — that one only surfaces as a Mongo E11000 on save().
		let order;
		let attempts = 0;
		const maxAttempts = 10;

		while (!order) {
			attempts++;
			if (attempts > maxAttempts) {
				console.error('❌ Failed to create order after', maxAttempts, 'attempts (orderCode collisions)');
				return res.status(500).json({
					success: false,
					message: 'Không thể tạo mã đơn hàng duy nhất'
				});
			}

			const orderCode = generateOrderCode();
			const existingOrder = await Order.findOne({ orderCode });
			if (existingOrder) {
				continue;
			}

			try {
				order = await new Order({
					orderCode,
					studentId,
					fullName,
					email,
					phoneNumber,
					additionalNote,
					items: orderItems,
					totalAmount,
					status: 'confirmed',
					lastUpdatedBy: 'system',
					comboInfo,
					statusHistory: [
						{
							status: 'confirmed',
							updatedBy: 'system',
							updatedAt: new Date(),
							note: 'Đơn hàng được tạo từ hệ thống'
						}
					]
				}).save();
			} catch (saveError) {
				if (saveError.code === 11000) {
					console.warn('⚠️ orderCode collision on save, retrying:', orderCode);
					continue; // another request took this code between findOne and save
				}
				throw saveError;
			}
		}

		console.log('✅ Order saved successfully:', order._id);

		// Generate payment QR URL and description
		let qrUrl = null;
		let paymentDescription = null;
		try {
			qrUrl = await generateOrderPaymentQR(totalAmount, order.orderCode, studentId, fullName);
			paymentDescription = await formatOrderPaymentDescription(order.orderCode, studentId, fullName);
			console.log('✅ QR URL generated:', qrUrl);
		} catch (qrError) {
			console.error('❌ Failed to generate QR URL:', qrError.message);
		}

		// Log dữ liệu gửi App Script
		const appscriptData = {
			orderCode: order.orderCode,
			studentId,
			fullName,
			email,
			phoneNumber,
			additionalNote,
			items: orderItems,
			totalAmount
		};
		console.log('Push to AppScript:', appscriptData);
		// Gửi lên App Script sau, không chờ kết quả
		setImmediate(() => {
			sendOrderToAppScript(appscriptData).catch(err => {
				console.error('Gửi đơn hàng lên App Script thất bại:', err.message);
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
		console.error('💥 Error creating order:', {
			error: error.message,
			stack: error.stack,
			timestamp: new Date().toISOString()
		});

		// More specific error handling
		if (error.name === 'ValidationError') {
			console.error('❌ Validation error details:', error.errors);
			return res.status(400).json({
				success: false,
				message: 'Dữ liệu đơn hàng không hợp lệ',
				errors: Object.values(error.errors).map(err => err.message)
			});
		}

		if (error.name === 'MongoError' || error.name === 'MongoServerError') {
			console.error('❌ Database error:', error.message);
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
});

/**
 * @route   GET /api/orders/:orderCode
 * @desc    Get order by order code (for customer tracking)
 * @access  Public
 */
router.get('/:orderCode', async (req, res) => {
	try {
		const { orderCode } = req.params;

		const order = await Order.findOne({
			orderCode: orderCode.toUpperCase()
		}).populate('items.productId', 'name description');

		if (!order) {
			return res.status(404).json({
				success: false,
				message: 'Không tìm thấy đơn hàng với mã này'
			});
		}

		// Generate QR code URL and payment description. studentId/fullName are
		// needed here to build them but must not leak into the response below
		// (P1-7 — this route is public to anyone holding the order code).
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
			console.error('Error generating payment info:', error);
		}

		// Return order information including payment details. studentId and
		// fullName are intentionally excluded — see the comment above.
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
					quantity: item.quantity,
					price: item.price
				}))
			}
		});

	} catch (error) {
		console.error('Error fetching order:', error);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi lấy thông tin đơn hàng'
		});
	}
});

module.exports = router;
