import React, { useState } from 'react';
import { toast } from 'react-toastify';
import { authClient, refreshSession } from '../../lib/auth-client';
import { useAuthIdentity } from '../../lib/use-storefronts';
import LoginPanel from '../auth/LoginPanel';

/**
 * What a private storefront shows instead of its catalog. `error` is the 401/403
 * the server answered with; `storefront` is the `{ slug, name }` it carries.
 * Access changes (sign-in, sign-out) refetch through the viewer identity, so
 * `onAccessChanged` is only a nudge for callers that want an immediate retry.
 */
const PrivateStorefrontGate = ({ storefront, error, onAccessChanged }) => {
	const { user } = useAuthIdentity();
	const [switching, setSwitching] = useState(false);
	const name = storefront?.name ?? 'này';
	const forbidden = error?.code === 'STOREFRONT_FORBIDDEN' && Boolean(user);

	const signInWithAnotherEmail = async () => {
		setSwitching(true);
		try {
			const { error: signOutError } = await authClient.signOut();
			if (signOutError) throw new Error(signOutError.message);
			refreshSession();
			onAccessChanged?.();
		} catch (failure) {
			toast.error(failure.message || 'Đăng xuất thất bại');
		} finally {
			setSwitching(false);
		}
	};

	return (
		<div className="container mx-auto px-4 py-10">
			<div className="card mx-auto max-w-md p-6">
				<div className="mb-5 text-center">
					<i className="fas fa-lock text-4xl text-gray-300"></i>
				</div>
				{forbidden ? (
					<div className="space-y-4 text-center" role="alert">
						<h2 className="text-xl font-bold text-gray-900">Chưa có quyền truy cập</h2>
						<p className="text-gray-700">
							Email <strong className="break-all">{user.email}</strong> chưa được cấp quyền vào gian hàng {name}.
						</p>
						<button
							type="button"
							onClick={signInWithAnotherEmail}
							disabled={switching}
							className="btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{switching ? 'Đang đăng xuất...' : 'Đăng nhập bằng email khác'}
						</button>
					</div>
				) : (
					<LoginPanel
						title={`Đăng nhập để xem gian hàng ${storefront?.name ?? ''}`.trim()}
						hint="Gian hàng này chỉ dành cho tài khoản được cấp quyền."
						onSignedIn={() => onAccessChanged?.()}
					/>
				)}
			</div>
		</div>
	);
};

export default PrivateStorefrontGate;
