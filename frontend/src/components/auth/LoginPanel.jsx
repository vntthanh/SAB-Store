import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { otpRequest, otpVerify, staffLogin } from '@sab/shared';
import { authClient, fetchFreshSession, refreshSession } from '../../lib/auth-client';
import { renderGoogleButton } from '../../lib/google-one-tap';
import {
	OTP_EXPIRES_MINUTES,
	OTP_RESEND_SECONDS,
	authErrorMessage,
	passwordSignInRequest,
} from '../../lib/auth-flow';
import { settingsService } from '../../services/api';
import LoadingSpinner from '../LoadingSpinner';
import FormField from '../form/FormField';
import OtpInput from './OtpInput';

// Google bakes the width into the button when it draws it, so a container that
// changes width (phone rotated) needs a redraw; Google's own iframe nudges the
// box by a pixel or two, which must not trigger one.
const REDRAW_WIDTH_DELTA_PX = 8;

const firstIssue = (result, fallback) => result.error?.issues?.[0]?.message ?? fallback;

/**
 * The only sign-in form: Google, email code, and the staff password. Used by the
 * header dialog, /login and the private-storefront gate, so every entry point
 * behaves the same. `onSignedIn(session)` runs once the session cookie is set.
 */
const LoginPanel = ({ onSignedIn, title, hint }) => {
	const uid = useId();
	const [settings, setSettings] = useState({ status: 'loading', googleClientId: null, otpAvailable: false });

	const [step, setStep] = useState('email');
	const [email, setEmail] = useState('');
	const [emailError, setEmailError] = useState(null);
	const [code, setCode] = useState('');
	const [otpError, setOtpError] = useState(null);
	const [sending, setSending] = useState(false);
	const [verifying, setVerifying] = useState(false);
	const [resendIn, setResendIn] = useState(0);

	const [showPassword, setShowPassword] = useState(false);
	const [identifier, setIdentifier] = useState('');
	const [password, setPassword] = useState('');
	const [passwordError, setPasswordError] = useState(null);
	const [signingIn, setSigningIn] = useState(false);

	const [googleNode, setGoogleNode] = useState(null);
	const [googleFailed, setGoogleFailed] = useState(false);

	useEffect(() => {
		let active = true;
		settingsService.getPublicSettings()
			.then((data) => {
				if (!active) return;
				setSettings({
					status: 'ready',
					googleClientId: data?.googleClientId || null,
					otpAvailable: data?.otpAvailable === true,
				});
			})
			.catch(() => {
				// Without settings neither Google nor the code can be offered; the staff form still works.
				if (active) setSettings({ status: 'error', googleClientId: null, otpAvailable: false });
			});
		return () => {
			active = false;
		};
	}, []);

	useEffect(() => {
		if (resendIn <= 0) return undefined;
		const timer = setTimeout(() => setResendIn((seconds) => Math.max(0, seconds - 1)), 1000);
		return () => clearTimeout(timer);
	}, [resendIn]);

	const onSignedInRef = useRef(onSignedIn);
	useEffect(() => {
		onSignedInRef.current = onSignedIn;
	});

	// Every method ends here: publish the new session to useSession() consumers,
	// then hand the role-bearing session to the caller.
	const finishSignIn = useCallback(async () => {
		refreshSession();
		const session = await fetchFreshSession();
		if (!session?.user) {
			toast.error('Không lấy được phiên đăng nhập, vui lòng thử lại');
			return;
		}
		toast.success('Đăng nhập thành công!');
		onSignedInRef.current?.(session);
	}, []);
	const finishSignInRef = useRef(finishSignIn);
	finishSignInRef.current = finishSignIn;

	const { googleClientId } = settings;
	useEffect(() => {
		if (!googleClientId || !googleNode) return undefined;

		const draw = () => renderGoogleButton({
			clientId: googleClientId,
			container: googleNode,
			onSuccess: () => {
				finishSignInRef.current().catch(() => toast.error('Đăng nhập thất bại'));
			},
			// A failed click is a real, user-initiated failure; silence here once hid a 500 for a whole release.
			onError: (error) => toast.error(authErrorMessage(error, 'Đăng nhập bằng Google thất bại')),
		}).catch(() => {
			// The Google script itself did not load (blocked or offline); the other methods stay usable.
			setGoogleFailed(true);
		});

		draw();
		let lastWidth = googleNode.clientWidth;
		const observer = new ResizeObserver(() => {
			const width = googleNode.clientWidth;
			if (width > 0 && Math.abs(width - lastWidth) >= REDRAW_WIDTH_DELTA_PX) {
				lastWidth = width;
				draw();
			}
		});
		observer.observe(googleNode);
		return () => observer.disconnect();
	}, [googleClientId, googleNode]);

	const sendCode = async (event) => {
		event?.preventDefault();
		const parsed = otpRequest.safeParse({ email });
		if (!parsed.success) {
			setEmailError(firstIssue(parsed, 'Email không hợp lệ'));
			return;
		}
		setEmailError(null);
		setOtpError(null);
		setSending(true);
		try {
			const { error } = await authClient.emailOtp.sendVerificationOtp({
				email: parsed.data.email.trim().toLowerCase(),
				type: 'sign-in',
			});
			if (error) {
				const message = authErrorMessage(error, 'Không gửi được mã');
				// The server's cooldown outlasts a refresh, so keep the resend button locked too.
				if (error.code === 'OTP_COOLDOWN') setResendIn(OTP_RESEND_SECONDS);
				if (step === 'email') setEmailError(message);
				else setOtpError(message);
				toast.error(message);
				return;
			}
			setEmail(parsed.data.email.trim().toLowerCase());
			setCode('');
			setStep('code');
			setResendIn(OTP_RESEND_SECONDS);
			toast.success('Đã gửi mã xác thực, vui lòng kiểm tra email');
		} catch (error) {
			toast.error(authErrorMessage(error, 'Không gửi được mã'));
		} finally {
			setSending(false);
		}
	};

	const verifyCode = async (event) => {
		event.preventDefault();
		const parsed = otpVerify.safeParse({ email, otp: code });
		if (!parsed.success) {
			setOtpError(firstIssue(parsed, 'Mã xác thực gồm đúng 6 chữ số'));
			return;
		}
		setOtpError(null);
		setVerifying(true);
		try {
			const { error } = await authClient.signIn.emailOtp({ email: parsed.data.email, otp: parsed.data.otp });
			if (error) {
				setOtpError(authErrorMessage(error, 'Mã xác thực không đúng'));
				return;
			}
			await finishSignIn();
		} catch (error) {
			setOtpError(authErrorMessage(error, 'Đăng nhập thất bại'));
		} finally {
			setVerifying(false);
		}
	};

	const restartEmailStep = () => {
		setStep('email');
		setCode('');
		setOtpError(null);
	};

	const submitPassword = async (event) => {
		event.preventDefault();
		const parsed = staffLogin.safeParse({ identifier, password });
		if (!parsed.success) {
			setPasswordError(firstIssue(parsed, 'Vui lòng nhập đủ thông tin'));
			return;
		}
		setPasswordError(null);
		setSigningIn(true);
		try {
			const { method, body } = passwordSignInRequest(parsed.data);
			const { error } = await authClient.signIn[method](body);
			if (error) {
				setPasswordError(authErrorMessage(error));
				return;
			}
			await finishSignIn();
		} catch (error) {
			setPasswordError(authErrorMessage(error));
		} finally {
			setSigningIn(false);
		}
	};

	const settled = settings.status !== 'loading';
	const offersGoogle = Boolean(googleClientId) && !googleFailed;
	const offersCode = settings.otpAvailable;
	// With no other way in, hiding the staff form behind a link would leave an empty panel.
	const passwordOpen = showPassword || (settled && !offersGoogle && !offersCode);

	return (
		<div className="space-y-5">
			{(title || hint) && (
				<div>
					{title && <h2 className="text-xl font-bold text-gray-900">{title}</h2>}
					{hint && <p className="mt-1 text-sm text-gray-600">{hint}</p>}
				</div>
			)}

			{!settled && <LoadingSpinner size="small" text="Đang tải..." className="py-4" />}

			{settings.status === 'error' && (
				<p className="rounded-lg bg-yellow-50 p-3 text-sm text-yellow-800" role="status">
					Không tải được các cách đăng nhập khác. Tài khoản nội bộ vẫn có thể đăng nhập bằng mật khẩu.
				</p>
			)}

			{googleClientId && (
				<div>
					{/* Google draws its own button here; it cannot be restyled, so there is no disabled state to show. */}
					<div ref={setGoogleNode} className="flex min-h-[44px] justify-center" data-testid="google-sign-in" />
					{googleFailed && (
						<p className="text-sm text-gray-600">Không tải được nút đăng nhập Google. Hãy dùng email bên dưới.</p>
					)}
				</div>
			)}

			{offersGoogle && offersCode && (
				<div className="flex items-center gap-3 text-xs uppercase text-gray-400" aria-hidden="true">
					<span className="h-px flex-1 bg-gray-200"></span>
					hoặc
					<span className="h-px flex-1 bg-gray-200"></span>
				</div>
			)}

			{offersCode && (
				step === 'email' ? (
					<form onSubmit={sendCode} noValidate className="space-y-3">
						<FormField id={`${uid}-email`} label="Email" error={emailError} hint="Chúng tôi sẽ gửi mã xác thực 6 chữ số đến email này">
							<input
								type="email"
								value={email}
								onChange={(event) => {
									setEmail(event.target.value);
									setEmailError(null);
								}}
								placeholder="ban@example.com"
								className="form-input"
								autoComplete="email"
								maxLength={254}
								disabled={sending}
							/>
						</FormField>
						<button type="submit" disabled={sending} className="btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed">
							{sending ? <LoadingSpinner size="small" text="Đang gửi mã..." /> : (
								<>
									<i className="fas fa-envelope mr-2"></i>
									Gửi mã
								</>
							)}
						</button>
					</form>
				) : (
					<form onSubmit={verifyCode} noValidate className="space-y-3">
						<div>
							<p className="text-sm text-gray-700">
								Đã gửi mã đến <strong className="break-all">{email}</strong>.{' '}
								<button type="button" onClick={restartEmailStep} className="text-primary-600 hover:underline">
									Đổi email
								</button>
							</p>
							<p className="mt-1 text-xs text-gray-500">Mã có hiệu lực {OTP_EXPIRES_MINUTES} phút.</p>
						</div>
						<div>
							<label htmlFor={`${uid}-code`} className="mb-2 block text-sm font-medium text-gray-700">
								Mã xác thực
							</label>
							<OtpInput id={`${uid}-code`} value={code} onChange={setCode} autoFocus invalid={Boolean(otpError)} disabled={verifying} />
							{otpError && <p className="mt-2 text-sm text-danger-600" role="alert">{otpError}</p>}
						</div>
						<button
							type="submit"
							disabled={verifying || code.length < 6}
							className="btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{verifying ? <LoadingSpinner size="small" text="Đang đăng nhập..." /> : (
								<>
									<i className="fas fa-sign-in-alt mr-2"></i>
									Đăng nhập
								</>
							)}
						</button>
						<button
							type="button"
							onClick={sendCode}
							disabled={sending || resendIn > 0}
							className="btn-secondary w-full disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{sending ? 'Đang gửi...' : resendIn > 0 ? `Gửi lại mã sau ${resendIn}s` : 'Gửi lại mã'}
						</button>
					</form>
				)
			)}

			<div className="border-t border-gray-200 pt-4">
				{!passwordOpen ? (
					<button
						type="button"
						onClick={() => setShowPassword(true)}
						className="text-sm text-gray-600 hover:text-gray-900"
						aria-expanded="false"
					>
						<i className="fas fa-user-shield mr-2"></i>
						Đăng nhập bằng mật khẩu (nội bộ)
					</button>
				) : (
					<form onSubmit={submitPassword} noValidate className="space-y-3">
						<p className="text-sm font-medium text-gray-700">
							<i className="fas fa-user-shield mr-2"></i>
							Đăng nhập bằng mật khẩu (nội bộ)
						</p>
						<FormField id={`${uid}-identifier`} label="Tên đăng nhập hoặc email">
							<input
								type="text"
								value={identifier}
								onChange={(event) => setIdentifier(event.target.value)}
								className="form-input"
								autoComplete="username"
								disabled={signingIn}
							/>
						</FormField>
						<FormField id={`${uid}-password`} label="Mật khẩu">
							<input
								type="password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								className="form-input"
								autoComplete="current-password"
								disabled={signingIn}
							/>
						</FormField>
						{passwordError && <p className="text-sm text-danger-600" role="alert">{passwordError}</p>}
						<button type="submit" disabled={signingIn} className="btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed">
							{signingIn ? <LoadingSpinner size="small" text="Đang đăng nhập..." /> : (
								<>
									<i className="fas fa-sign-in-alt mr-2"></i>
									Đăng nhập
								</>
							)}
						</button>
					</form>
				)}
			</div>
		</div>
	);
};

export default LoginPanel;
