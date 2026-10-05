import { z } from 'zod';

const MISSING = 'Thiếu dữ liệu bắt buộc';

const EXPECTED_TYPE = {
	string: 'chuỗi',
	number: 'số',
	int: 'số nguyên',
	boolean: 'đúng/sai',
	bigint: 'số nguyên lớn',
	array: 'danh sách',
	object: 'đối tượng',
	date: 'ngày',
	record: 'đối tượng',
	map: 'bản đồ',
	set: 'tập hợp',
	file: 'tệp',
};

const UNIT = { string: 'ký tự', array: 'phần tử', set: 'phần tử', file: 'byte' };

function bound(iss, direction) {
	const limit = direction === 'min' ? iss.minimum : iss.maximum;
	const unit = UNIT[iss.origin];
	if (iss.exact) return `Phải có đúng ${limit} ${unit ?? ''}`.trim();
	if (unit) {
		return direction === 'min'
			? `Phải có ít nhất ${limit} ${unit}`
			: `Không được vượt quá ${limit} ${unit}`;
	}
	if (iss.origin === 'date') {
		return direction === 'min' ? 'Ngày quá sớm' : 'Ngày quá muộn';
	}
	const relation = direction === 'min'
		? (iss.inclusive === false ? 'lớn hơn' : 'lớn hơn hoặc bằng')
		: (iss.inclusive === false ? 'nhỏ hơn' : 'nhỏ hơn hoặc bằng');
	return `Giá trị phải ${relation} ${limit}`;
}

// Replaces every message Zod would produce on its own, so no English default
// can reach a user. A message set on a schema still wins over this map.
// Always returns a string: returning undefined falls through to the English
// locale.
function customError(iss) {
	switch (iss.code) {
		case 'invalid_type':
			if (iss.input === undefined || iss.input === null) return MISSING;
			return `Kiểu dữ liệu không hợp lệ (cần ${EXPECTED_TYPE[iss.expected] ?? iss.expected})`;
		case 'too_small':
			return bound(iss, 'min');
		case 'too_big':
			return bound(iss, 'max');
		case 'invalid_format':
			return iss.format === 'email' ? 'Email không hợp lệ' : 'Định dạng không hợp lệ';
		case 'not_multiple_of':
			return `Giá trị phải là bội số của ${iss.divisor}`;
		case 'unrecognized_keys':
			return `Có trường không được hỗ trợ: ${iss.keys.join(', ')}`;
		case 'invalid_value':
		case 'invalid_union':
			return 'Giá trị không hợp lệ';
		case 'invalid_key':
			return 'Khóa không hợp lệ';
		case 'invalid_element':
			return 'Phần tử không hợp lệ';
		default:
			return 'Dữ liệu không hợp lệ';
	}
}

// jitless: Zod otherwise probes `new Function`, which the storefront CSP (script-src 'self')
// reports on every page load and would block once the policy is enforced.
z.config({ customError, jitless: true });

export { z, customError };
