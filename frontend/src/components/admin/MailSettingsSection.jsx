import React, { useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { mailSettingsUpdate, mailTestRequest } from '@sab/shared';
import { mailSettingsService } from '../../services/api';
import LoadingSpinner from '../LoadingSpinner';
import FormField from '../form/FormField';
import useFieldErrors from '../../hooks/use-field-errors';

const DEFAULT_PORT = 587;

const INPUT_CLASS = 'w-full h-10 px-4 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent';
const PRIMARY_BUTTON_CLASS = 'h-10 px-6 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors';

// Mail is off until an admin switches it on; both mail kinds default on once it is.
const EMPTY_FORM = {
	enabled: false,
	host: '',
	port: String(DEFAULT_PORT),
	secure: false,
	username: '',
	pass: '',
	fromName: '',
	fromAddress: '',
	notifyOrderCreated: true,
	notifyStatusChanged: true
};

// The password is write-only: the form never holds the stored one, `pass` starts and
// returns to empty after every load/save.
export const toForm = (saved) => (saved ? {
	enabled: Boolean(saved.enabled),
	host: saved.host ?? '',
	port: String(saved.port ?? DEFAULT_PORT),
	secure: Boolean(saved.secure),
	username: saved.username ?? '',
	pass: '',
	fromName: saved.fromName ?? '',
	fromAddress: saved.fromAddress ?? '',
	notifyOrderCreated: Boolean(saved.notifyOrderCreated),
	notifyStatusChanged: Boolean(saved.notifyStatusChanged)
} : { ...EMPTY_FORM });

// Blank password = keep the stored one, so the key is omitted rather than sent empty.
export const buildPayload = (values) => {
	const payload = {
		enabled: values.enabled,
		host: values.host.trim(),
		port: Number(values.port),
		secure: values.secure,
		username: values.username.trim(),
		fromName: values.fromName.trim(),
		fromAddress: values.fromAddress.trim(),
		notifyOrderCreated: values.notifyOrderCreated,
		notifyStatusChanged: values.notifyStatusChanged
	};
	if (values.pass !== '') payload.pass = values.pass;
	return payload;
};

export const isDirty = (values, saved) => {
	const base = toForm(saved);
	return Object.keys(base).some((key) => values[key] !== base[key]);
};

const PASSWORD_REQUIRED_MESSAGE = 'Mật khẩu SMTP là bắt buộc khi cấu hình lần đầu';

// First message per field from the shared schema (the server stays authoritative). `pass` is
// optional in the schema because a blank one keeps the stored password; on first setup there is
// none to keep, which the schema cannot know.
export const validateMailForm = (values, hasPassword) => {
	const errors = {};
	const result = mailSettingsUpdate.safeParse(buildPayload(values));
	if (!result.success) {
		for (const issue of result.error.issues) {
			const field = issue.path[0];
			if (typeof field === 'string' && !errors[field]) errors[field] = issue.message;
		}
	}
	if (!hasPassword && values.pass === '' && !errors.pass) errors.pass = PASSWORD_REQUIRED_MESSAGE;
	return errors;
};

const firstTestIssue = (to) => {
	const result = mailTestRequest.safeParse({ to: to.trim() });
	return result.success ? null : result.error.issues[0].message;
};

const FIELD_NAMES = ['host', 'port', 'username', 'pass', 'fromName', 'fromAddress'];

const SwitchRow = ({ id, checked, onChange, disabled, label, hint }) => (
	<div className="flex items-start gap-3">
		<input
			id={id}
			type="checkbox"
			role="switch"
			checked={checked}
			onChange={onChange}
			disabled={disabled}
			className="mt-1 h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500"
		/>
		<label htmlFor={id} className="text-sm text-gray-700">
			<span className="font-medium">{label}</span>
			{hint && <span className="block text-gray-500">{hint}</span>}
		</label>
	</div>
);

// onSave(payload) resolves { data } or { error }; onTest(to) resolves truthy on success. Both
// toast their own failures; this component owns the form, its field errors and pending flags.
const MailSettingsForm = ({ saved, onSave, onTest }) => {
	const [values, setValues] = useState(() => toForm(saved));
	const [saving, setSaving] = useState(false);
	const [testing, setTesting] = useState(false);
	const [testTo, setTestTo] = useState('');
	const [testError, setTestError] = useState(null);
	const formRef = useRef(null);

	const hasPassword = Boolean(saved?.hasPassword);
	const rules = Object.fromEntries(
		FIELD_NAMES.map((name) => [name, (_value, all) => validateMailForm(all, hasPassword)[name] ?? null])
	);
	const { errors, validateField, onFieldChange, validateAll, setServerErrors, focusFirstError, reset } = useFieldErrors(rules);
	const dirty = isDirty(values, saved);
	const busy = saving || testing;

	const setField = (name, value) => {
		setValues((prev) => ({ ...prev, [name]: value }));
		onFieldChange(name, value, { ...values, [name]: value });
	};
	const onText = (e) => setField(e.target.name, e.target.value);
	const onBlur = (e) => validateField(e.target.name, e.target.value, values);

	const handleSubmit = async (e) => {
		e.preventDefault();
		if (saving) return;
		if (!validateAll(values)) {
			focusFirstError(formRef);
			return;
		}
		setSaving(true);
		try {
			const result = await onSave(buildPayload(values));
			if (result?.data) {
				setValues(toForm(result.data));
				reset();
			} else if (result?.error) {
				setServerErrors(result.error);
				focusFirstError(formRef);
			}
		} finally {
			setSaving(false);
		}
	};

	const handleTest = async (e) => {
		e.preventDefault();
		if (testing) return;
		const message = firstTestIssue(testTo);
		setTestError(message);
		if (message) return;
		setTesting(true);
		try {
			await onTest(testTo.trim());
		} finally {
			setTesting(false);
		}
	};

	return (
		<div className="space-y-6">
			<form ref={formRef} onSubmit={handleSubmit} noValidate className="space-y-6">
				<div className="p-4 bg-gray-50 rounded-md">
					<SwitchRow
						id="mail-enabled"
						checked={values.enabled}
						onChange={(e) => setField('enabled', e.target.checked)}
						disabled={saving}
						label="Gửi email"
						hint="Mặc định TẮT. Khi tắt, hệ thống không gửi bất kỳ email nào."
					/>
				</div>

				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
					<FormField id="mail-host" label="Máy chủ SMTP" error={errors.host}>
						<input type="text" name="host" value={values.host} onChange={onText} onBlur={onBlur} disabled={saving}
							placeholder="VD: smtp.gmail.com" autoComplete="off" className={INPUT_CLASS} />
					</FormField>
					<FormField id="mail-port" label="Cổng SMTP" error={errors.port}>
						<input type="number" name="port" value={values.port} onChange={onText} onBlur={onBlur} disabled={saving}
							min={1} max={65535} className={INPUT_CLASS} />
					</FormField>
					<FormField id="mail-username" label="Tài khoản SMTP" error={errors.username}>
						<input type="text" name="username" value={values.username} onChange={onText} onBlur={onBlur} disabled={saving}
							autoComplete="off" className={INPUT_CLASS} />
					</FormField>
					<FormField id="mail-pass" label="Mật khẩu SMTP" required={!hasPassword} error={errors.pass}>
						<input type="password" name="pass" value={values.pass} onChange={onText} onBlur={onBlur} disabled={saving}
							placeholder={hasPassword ? 'Đã lưu — để trống để giữ nguyên' : 'Nhập mật khẩu SMTP'}
							autoComplete="new-password" className={INPUT_CLASS} />
					</FormField>
					<FormField id="mail-fromName" label="Tên người gửi" error={errors.fromName}>
						<input type="text" name="fromName" value={values.fromName} onChange={onText} onBlur={onBlur} disabled={saving}
							placeholder="VD: SAB Store" className={INPUT_CLASS} />
					</FormField>
					<FormField id="mail-fromAddress" label="Địa chỉ email người gửi" error={errors.fromAddress}>
						<input type="email" name="fromAddress" value={values.fromAddress} onChange={onText} onBlur={onBlur} disabled={saving}
							placeholder="VD: shop@example.com" className={INPUT_CLASS} />
					</FormField>
				</div>

				<SwitchRow
					id="mail-secure"
					checked={values.secure}
					onChange={(e) => setField('secure', e.target.checked)}
					disabled={saving}
					label="Dùng SSL/TLS (cổng 465)"
					hint="Bỏ chọn với cổng 587 (STARTTLS)."
				/>

				<div className="space-y-3">
					<h3 className="text-sm font-medium text-gray-700">Loại email sẽ gửi</h3>
					<SwitchRow
						id="mail-notifyOrderCreated"
						checked={values.notifyOrderCreated}
						onChange={(e) => setField('notifyOrderCreated', e.target.checked)}
						disabled={saving}
						label="Xác nhận đơn cho khách"
					/>
					<SwitchRow
						id="mail-notifyStatusChanged"
						checked={values.notifyStatusChanged}
						onChange={(e) => setField('notifyStatusChanged', e.target.checked)}
						disabled={saving}
						label="Báo đổi trạng thái đơn"
					/>
				</div>

				<div className="flex gap-4">
					<button type="submit" disabled={saving || testing || !dirty} className={`flex-1 ${PRIMARY_BUTTON_CLASS}`}>
						{saving ? 'Đang lưu...' : 'Lưu cấu hình email'}
					</button>
					{dirty && (
						<button
							type="button"
							onClick={() => { setValues(toForm(saved)); reset(); }}
							disabled={busy}
							className="h-10 px-6 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
						>
							Hủy bỏ
						</button>
					)}
				</div>
			</form>

			<form onSubmit={handleTest} noValidate className="border-t border-gray-200 pt-6">
				<FormField id="mail-test-to" label="Gửi email thử" error={testError}>
					<input
						type="email"
						value={testTo}
						onChange={(e) => { setTestTo(e.target.value); setTestError(null); }}
						disabled={testing}
						placeholder="Email nhận thư thử"
						className={INPUT_CLASS}
					/>
				</FormField>
				<div className="mt-3 flex items-center gap-4">
					<button type="submit" disabled={testing || saving || dirty} className={`shrink-0 ${PRIMARY_BUTTON_CLASS}`}>
						{testing ? 'Đang gửi...' : 'Gửi thử'}
					</button>
					<p className="text-sm text-gray-500">
						Thư thử dùng cấu hình ĐÃ LƯU{dirty ? ' — bạn có thay đổi chưa lưu, hãy lưu trước khi gửi thử.' : '.'}
					</p>
				</div>
			</form>
		</div>
	);
};

const MailSettingsSection = () => {
	const [state, setState] = useState({ status: 'loading', saved: null });

	const load = async () => {
		setState({ status: 'loading', saved: null });
		try {
			setState({ status: 'ready', saved: await mailSettingsService.get() });
		} catch (error) {
			setState({ status: 'error', saved: null, message: error.message });
		}
	};

	useEffect(() => {
		load();
	}, []);

	const handleSave = async (payload) => {
		try {
			const result = await mailSettingsService.update(payload);
			toast.success(result.message || 'Cập nhật cấu hình email thành công');
			setState({ status: 'ready', saved: result.data });
			return { data: result.data };
		} catch (error) {
			// A schema rejection carries the reason per field; the top-level message is generic.
			const reasons = (error.fieldErrors || []).map((entry) => entry.message).filter(Boolean);
			toast.error(reasons.length ? `${error.message}: ${reasons.join('; ')}` : error.message);
			return { error };
		}
	};

	const handleTest = async (to) => {
		try {
			const result = await mailSettingsService.sendTest(to);
			toast.success(result.message || 'Đã gửi email thử');
			return result;
		} catch (error) {
			toast.error(error.message);
			return null;
		}
	};

	return (
		<div className="bg-white rounded-lg shadow-md p-6">
			<h2 className="text-xl font-bold mb-2">Email (SMTP)</h2>
			<p className="text-sm text-gray-500 mb-6">
				Gửi email xác nhận đơn và thông báo đổi trạng thái đơn cho khách. Mật khẩu được mã hóa khi lưu và không bao giờ hiển thị lại.
			</p>

			{state.status === 'loading' && <LoadingSpinner />}

			{state.status === 'error' && (
				<div role="alert" className="p-4 bg-red-50 border border-red-200 rounded-md">
					<p className="text-sm text-red-700 mb-3">{state.message || 'Lỗi khi tải cấu hình email'}</p>
					<button type="button" onClick={load} className="h-10 px-6 border border-gray-300 rounded-md bg-white hover:bg-gray-50">
						Thử lại
					</button>
				</div>
			)}

			{state.status === 'ready' && (
				<MailSettingsForm saved={state.saved} onSave={handleSave} onTest={handleTest} />
			)}
		</div>
	);
};

export default MailSettingsSection;
