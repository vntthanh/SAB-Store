import { z } from '../z.js';
import { wholeNumber } from './primitives.js';

// SMTP account used for order mail. The password is a credential: `pass` is
// validated as sent and never trimmed, so the stored value is what was typed.

const HOST_MAX = 253;
const USERNAME_MAX = 254;
const PASSWORD_MAX = 256;
const FROM_NAME_MAX = 100;

const HOST_MESSAGE = `Máy chủ SMTP phải từ 1 đến ${HOST_MAX} ký tự, chỉ gồm chữ, số, dấu chấm và gạch`;
const PORT_MESSAGE = 'Cổng SMTP phải là số nguyên từ 1 đến 65535';
const USERNAME_MESSAGE = `Tài khoản SMTP phải từ 1 đến ${USERNAME_MAX} ký tự`;
const PASSWORD_MESSAGE = `Mật khẩu SMTP không được vượt quá ${PASSWORD_MAX} ký tự`;
const FROM_NAME_MESSAGE = `Tên người gửi phải từ 1 đến ${FROM_NAME_MAX} ký tự và không xuống dòng`;
const FROM_ADDRESS_MESSAGE = 'Địa chỉ email người gửi không hợp lệ';
const TO_MESSAGE = 'Địa chỉ email người nhận không hợp lệ';

const flag = (label) => z.boolean({ error: `${label} phải là đúng/sai` });
const email = (message) => z.string({ error: message }).trim().max(USERNAME_MAX, message).pipe(z.email(message));

export const mailSettingsUpdate = z.object({
	enabled: flag('Công tắc gửi mail'),
	host: z
		.string({ error: HOST_MESSAGE })
		.trim()
		.min(1, HOST_MESSAGE)
		.max(HOST_MAX, HOST_MESSAGE)
		.regex(/^[A-Za-z0-9._:[\]-]+$/, HOST_MESSAGE),
	port: wholeNumber({ min: 1, max: 65535, message: PORT_MESSAGE }),
	secure: flag('Chế độ bảo mật SMTP'),
	username: z.string({ error: USERNAME_MESSAGE }).trim().min(1, USERNAME_MESSAGE).max(USERNAME_MAX, USERNAME_MESSAGE),
	pass: z.string({ error: PASSWORD_MESSAGE }).max(PASSWORD_MAX, PASSWORD_MESSAGE).optional(),
	fromName: z
		.string({ error: FROM_NAME_MESSAGE })
		.trim()
		.min(1, FROM_NAME_MESSAGE)
		.max(FROM_NAME_MAX, FROM_NAME_MESSAGE)
		.refine((value) => !/[\r\n]/.test(value), FROM_NAME_MESSAGE),
	fromAddress: email(FROM_ADDRESS_MESSAGE),
	notifyOrderCreated: flag('Công tắc mail xác nhận đơn'),
	notifyStatusChanged: flag('Công tắc mail đổi trạng thái'),
});

export const mailTestRequest = z.object({ to: email(TO_MESSAGE) });
