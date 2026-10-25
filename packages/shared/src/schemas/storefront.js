import { z } from '../z.js';
import { recordId } from './primitives.js';
import { EMAIL_MAX_LENGTH, isValidEmail, normalizeEmail } from '../email-list.js';

// Same rule as the storefronts_slug_check constraint in the database.
export const STOREFRONT_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SLUG_MESSAGE = 'Đường dẫn phải từ 2 đến 60 ký tự, gồm chữ thường, số và dấu gạch ngang giữa các cụm';
const NAME_MESSAGE = 'Tên phải từ 1 đến 80 ký tự';
const DESCRIPTION_MESSAGE = 'Mô tả không được vượt quá 500 ký tự';
const EMAIL_MESSAGE = 'Email không hợp lệ';
const DOMAIN_MESSAGE = 'Tên miền không hợp lệ (ví dụ: school.edu.vn)';
const ID_MESSAGE = 'Mã không hợp lệ';

/**
 * An email as a request carries it: trimmed, validated on the trimmed value.
 * The handler lowercases it (the middleware only validates).
 */
export const emailAddress = z
	.string({ error: EMAIL_MESSAGE })
	.refine((value) => normalizeEmail(value).length <= EMAIL_MAX_LENGTH && isValidEmail(value), EMAIL_MESSAGE);

export const storefrontSlug = z
	.string({ error: SLUG_MESSAGE })
	.min(2, SLUG_MESSAGE)
	.max(60, SLUG_MESSAGE)
	.regex(STOREFRONT_SLUG_PATTERN, SLUG_MESSAGE);

const name = z.string({ error: NAME_MESSAGE }).trim().min(1, NAME_MESSAGE).max(80, NAME_MESSAGE);
const description = z.string({ error: DESCRIPTION_MESSAGE }).trim().max(500, DESCRIPTION_MESSAGE).nullish();

const storefrontFields = {
	name,
	slug: storefrontSlug,
	description,
	visibility: z.enum(['PUBLIC', 'PRIVATE'], { error: 'Chế độ hiển thị phải là PUBLIC hoặc PRIVATE' }),
	isActive: z.boolean({ error: 'Trạng thái hoạt động phải là đúng/sai' }),
};

export const storefrontCreate = z.object(storefrontFields);

const NOTHING_TO_UPDATE = 'Cần ít nhất một trường để cập nhật';
const hasAnyKey = (body) => Object.keys(body).length > 0;

export const storefrontUpdate = z.object(storefrontFields).partial().refine(hasAnyKey, NOTHING_TO_UPDATE);

const unique = (ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length;

/** 1..max unique record ids; shared by storefront reorder and a combo's storefront list. */
export const storefrontIdList = (max = 100) =>
	z
		.array(recordId(ID_MESSAGE), { error: 'Danh sách mã không hợp lệ' })
		.min(1, 'Cần ít nhất 1 mã')
		.max(max, `Không được vượt quá ${max} mã`)
		.refine(unique, 'Danh sách mã bị trùng');

export const storefrontReorder = z.object({ ids: storefrontIdList(100) });

// A product belongs to exactly one storefront, so its request field is a plain
// record id; a combo spans several and uses storefrontIdList.
export const productStorefrontId = recordId('Gian hàng không hợp lệ');

// Lowercase labels of letters, digits and inner hyphens, at least two labels:
// "edu" alone would match every address ending in ".edu" only by accident.
const DOMAIN_PATTERN = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const domain = z.string({ error: DOMAIN_MESSAGE }).trim().regex(DOMAIN_PATTERN, DOMAIN_MESSAGE);

export const accessRuleCreate = z.discriminatedUnion(
	'type',
	[
		z.object({ type: z.literal('EMAIL'), value: emailAddress }),
		z.object({ type: z.literal('DOMAIN'), value: domain }),
		z.object({ type: z.literal('LIST'), emailListId: recordId('Danh sách email không hợp lệ') }),
	],
	{ error: 'Loại quy tắc phải là EMAIL, DOMAIN hoặc LIST' },
);

export const EMAIL_LIST_ENTRIES_MAX = 5000;

export const emailListCreate = z.object({ name, description });
export const emailListUpdate = z.object({ name, description }).partial().refine(hasAnyKey, NOTHING_TO_UPDATE);

export const emailListEntriesAdd = z.object({
	emails: z
		.array(emailAddress, { error: 'Danh sách email không hợp lệ' })
		.min(1, 'Cần ít nhất 1 email')
		.max(EMAIL_LIST_ENTRIES_MAX, `Không được vượt quá ${EMAIL_LIST_ENTRIES_MAX} email`),
});
