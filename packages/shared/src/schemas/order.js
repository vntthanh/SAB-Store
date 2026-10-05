import { z } from '../z.js';
import { STUDENT_ID_HINT, studentId } from './student-id.js';
import {
	arrayElement,
	mongoId,
	nullishAsEmpty,
	onlyStrings,
	optionalText,
	wholeNumber,
} from './primitives.js';

const PRODUCT_ID_INVALID = 'ID sản phẩm không hợp lệ';
const ORDER_ID_INVALID = 'ID đơn hàng không hợp lệ';

const NAME_PATTERN = /^[a-zA-ZÀ-ỹ\s]+$/;
const PHONE_PATTERN = /^0[0-9]{9}$/;

export const ORDER_STATUSES = ['confirmed', 'paid', 'delivered', 'cancelled'];

/** `:id` of an order route. */
export const orderIdParams = z.object({ id: mongoId(ORDER_ID_INVALID) });

// The total the client displayed. Mandatory so an order can never be placed
// without the customer having seen a price; the route compares it with the
// recomputed total. A refinement rather than int()/min(): 1e21 is an integer
// here, and the route answers it with a price mismatch.
const TOTAL_MISSING = 'Thiếu tổng tiền hiển thị, vui lòng tải lại trang';
const TOTAL_INVALID = 'Tổng tiền hiển thị không hợp lệ';
export const expectedTotal = z
	.number({ error: (iss) => (iss.input === undefined || iss.input === null ? TOTAL_MISSING : TOTAL_INVALID) })
	.refine((n) => Number.isInteger(n) && n >= 0, TOTAL_INVALID);

// Customer-entered text is trimmed before it is checked: a stray space at the
// edge of a pasted value is not a reason to refuse the order. The routes trim
// the values they store themselves; validation never rewrites the request.
const fullName = nullishAsEmpty(onlyStrings(
	'Họ tên phải từ 2-100 ký tự',
	z.string()
		.trim()
		.min(1, 'Họ tên là bắt buộc')
		.min(2, 'Họ tên phải từ 2-100 ký tự')
		.max(100, 'Họ tên phải từ 2-100 ký tự')
		.regex(NAME_PATTERN, 'Họ tên chỉ được chứa chữ cái và khoảng trắng'),
));

// Not lower-cased or otherwise normalised: the address stored on the order
// must be what the customer typed.
const email = nullishAsEmpty(onlyStrings(
	'Email không hợp lệ',
	z.string()
		.trim()
		.email('Email không hợp lệ')
		.max(100, 'Email không được vượt quá 100 ký tự'),
));

const phoneNumber = nullishAsEmpty(onlyStrings(
	'Số điện thoại phải có 10 số và bắt đầu bằng 0',
	z.string()
		.trim()
		.min(1, 'Số điện thoại là bắt buộc')
		.regex(PHONE_PATTERN, 'Số điện thoại phải có 10 số và bắt đầu bằng 0'),
));

const additionalNote = optionalText({
	max: 500,
	typeMessage: 'Ghi chú không hợp lệ',
	maxMessage: 'Ghi chú không được vượt quá 500 ký tự',
});

const ORDER_ITEMS_REQUIRED = 'Đơn hàng phải có ít nhất 1 sản phẩm';

export const orderCreate = z.object({
	studentId: nullishAsEmpty(onlyStrings(STUDENT_ID_HINT, studentId)),
	fullName,
	email,
	phoneNumber,
	additionalNote,
	items: z
		.array(
			arrayElement({
				productId: mongoId(PRODUCT_ID_INVALID),
				quantity: wholeNumber({ min: 1, max: 100, message: 'Số lượng phải từ 1-100' }),
			}),
			{ error: ORDER_ITEMS_REQUIRED },
		)
		.min(1, ORDER_ITEMS_REQUIRED),
	expectedTotal,
});

// A counter sale. The items and the over-the-limit override are checked by the
// route and the pricing engine, which answer with their own error shapes;
// only the displayed total is validated here.
export const directOrder = z.object({
	expectedTotal,
	allowOverMax: z.unknown().optional(),
});

export const orderUpdate = z.object({
	status: z.enum(ORDER_STATUSES, { error: 'Trạng thái không hợp lệ' }),
	transactionCode: optionalText({
		max: 50,
		typeMessage: 'Mã giao dịch không hợp lệ',
		maxMessage: 'Mã giao dịch không được vượt quá 50 ký tự',
	}),
	cancelReason: optionalText({
		max: 500,
		typeMessage: 'Lý do hủy không hợp lệ',
		maxMessage: 'Lý do hủy không được vượt quá 500 ký tự',
	}),
	note: optionalText({
		max: 500,
		typeMessage: 'Ghi chú không hợp lệ',
		maxMessage: 'Ghi chú không được vượt quá 500 ký tự',
	}),
});

const EDIT_ITEMS_RANGE = 'Danh sách sản phẩm phải có từ 1 đến 50 dòng';
const REASON_RANGE = 'Lý do phải từ 1 đến 200 ký tự';

export const orderItemsEdit = z.object({
	items: z
		.array(
			arrayElement({
				productId: mongoId(PRODUCT_ID_INVALID),
				quantity: wholeNumber({ min: 1, message: 'Số lượng phải là số nguyên từ 1 trở lên' }),
			}),
			{ error: EDIT_ITEMS_RANGE },
		)
		.min(1, EDIT_ITEMS_RANGE)
		.max(50, EDIT_ITEMS_RANGE),
	expectedRevision: wholeNumber({ min: 0, message: 'expectedRevision phải là số nguyên không âm' }),
	reason: onlyStrings(
		'Lý do không hợp lệ',
		z.string().trim().min(1, REASON_RANGE).max(200, REASON_RANGE),
	),
});

const NOTES_REQUIRED = 'Cần ít nhất một trong additionalNote hoặc note';

// `additionalNote` may be empty (clears the customer note); `note` may not.
export const orderNotes = z
	.object({
		additionalNote: optionalText({
			max: 500,
			typeMessage: 'Ghi chú khách hàng không hợp lệ',
			maxMessage: 'Ghi chú không được vượt quá 500 ký tự',
			nullable: false,
		}),
		note: onlyStrings(
			'Ghi chú nội bộ không hợp lệ',
			z.string()
				.trim()
				.min(1, 'Ghi chú nội bộ phải từ 1 đến 500 ký tự')
				.max(500, 'Ghi chú nội bộ phải từ 1 đến 500 ký tự'),
		).optional(),
	})
	.refine((body) => body.additionalNote !== undefined || body.note !== undefined, {
		message: NOTES_REQUIRED,
		path: [],
	});
