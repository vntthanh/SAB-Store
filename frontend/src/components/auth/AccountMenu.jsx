import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'react-toastify';
import { authClient, refreshSession } from '../../lib/auth-client';
import { canUseAdmin, canUseSeller } from '../../lib/auth-flow';

const AccountMenu = ({ user }) => {
	const [open, setOpen] = useState(false);
	const [signingOut, setSigningOut] = useState(false);
	const rootRef = useRef(null);

	useEffect(() => {
		if (!open) return undefined;
		const onPointerDown = (event) => {
			if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
		};
		const onKeyDown = (event) => {
			if (event.key === 'Escape') setOpen(false);
		};
		document.addEventListener('mousedown', onPointerDown);
		document.addEventListener('keydown', onKeyDown);
		return () => {
			document.removeEventListener('mousedown', onPointerDown);
			document.removeEventListener('keydown', onKeyDown);
		};
	}, [open]);

	const signOut = async () => {
		setSigningOut(true);
		try {
			const { error } = await authClient.signOut();
			if (error) throw new Error(error.message);
			refreshSession();
			setOpen(false);
			toast.success('Đã đăng xuất');
		} catch (error) {
			toast.error(error.message || 'Đăng xuất thất bại');
		} finally {
			setSigningOut(false);
		}
	};

	const itemClass = 'block w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50';

	return (
		<div className="relative" ref={rootRef}>
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="flex h-12 items-center gap-2 rounded-lg bg-gray-100 px-3 text-sm font-medium text-gray-900 hover:bg-gray-200"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={`Tài khoản ${user.email}`}
			>
				<i className="fas fa-user-circle text-lg text-gray-600"></i>
				<span className="hidden max-w-[10rem] truncate sm:inline">{user.email}</span>
			</button>

			{open && (
				<div role="menu" className="absolute right-0 z-50 mt-2 w-60 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
					<p className="truncate border-b border-gray-100 px-4 py-2 text-xs text-gray-500">{user.email}</p>
					{canUseAdmin(user) && (
						<Link to="/admin/dashboard" role="menuitem" className={itemClass} onClick={() => setOpen(false)}>
							<i className="fas fa-cog mr-2 text-gray-400"></i>
							Quản trị
						</Link>
					)}
					{canUseSeller(user) && (
						<Link to="/seller/dashboard" role="menuitem" className={itemClass} onClick={() => setOpen(false)}>
							<i className="fas fa-cash-register mr-2 text-gray-400"></i>
							Bán hàng
						</Link>
					)}
					<button
						type="button"
						role="menuitem"
						onClick={signOut}
						disabled={signingOut}
						className={`${itemClass} disabled:opacity-50 disabled:cursor-not-allowed`}
					>
						<i className="fas fa-sign-out-alt mr-2 text-gray-400"></i>
						{signingOut ? 'Đang đăng xuất...' : 'Đăng xuất'}
					</button>
				</div>
			)}
		</div>
	);
};

export default AccountMenu;
