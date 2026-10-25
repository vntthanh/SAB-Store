import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import LoginPanel from './LoginPanel';

// components/Modal.jsx caps its body at 384px and adds a footer button; the
// code step of the login form is taller than that, so the dialog has its own
// shell. Closing unmounts the panel, which resets any half-entered code.
const LoginDialog = ({ isOpen, onClose, onSignedIn, title = 'Đăng nhập', hint }) => {
	useEffect(() => {
		if (!isOpen) return undefined;
		const onKeyDown = (event) => {
			if (event.key === 'Escape') onClose();
		};
		document.addEventListener('keydown', onKeyDown);
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			document.removeEventListener('keydown', onKeyDown);
			document.body.style.overflow = previousOverflow;
		};
	}, [isOpen, onClose]);

	if (!isOpen) return null;

	return createPortal(
		<div
			className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/50 p-4"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={title}
				className="relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg bg-white p-6 shadow-2xl"
			>
				<button
					type="button"
					onClick={onClose}
					className="absolute right-3 top-3 text-gray-400 transition-colors hover:text-gray-600"
					aria-label="Đóng"
				>
					<i className="fas fa-times text-xl"></i>
				</button>
				<LoginPanel
					title={title}
					hint={hint}
					onSignedIn={(session) => {
						onClose();
						onSignedIn?.(session);
					}}
				/>
			</div>
		</div>,
		document.getElementById('modal-root') || document.body
	);
};

export default LoginDialog;
