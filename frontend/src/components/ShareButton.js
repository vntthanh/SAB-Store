import React, { useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { absoluteUrl, copyLink } from '../utils/share-links';

const DEFAULT_LABELS = { share: 'Chia sẻ', copy: 'Sao chép link' };

/**
 * mode="share": Web Share API, lùi về sao chép link khi trình duyệt không hỗ trợ.
 * mode="copy": luôn sao chép link, để khách có link kể cả khi bảng chia sẻ không có "Sao chép".
 * Hai mode dùng chung kích thước để đặt cạnh nhau.
 */
const ShareButton = ({
	path,
	title,
	mode = 'share',
	label,
	disabledHint,
	className = ''
}) => {
	const [working, setWorking] = useState(false);
	const [manualUrl, setManualUrl] = useState('');
	const inputRef = useRef(null);
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	useEffect(() => {
		if (manualUrl && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [manualUrl]);

	const copyOrAskManual = async (url) => {
		const result = await copyLink(url);
		if (result === 'copied') {
			toast.success('Đã sao chép link');
			if (mountedRef.current) setManualUrl('');
		} else if (mountedRef.current) {
			toast.info('Không tự sao chép được, hãy chép link bên dưới');
			setManualUrl(url);
		}
	};

	const handleClick = async () => {
		if (working || !path) return;
		setWorking(true);
		const url = absoluteUrl(path);
		try {
			if (mode === 'share' && typeof navigator.share === 'function') {
				try {
					await navigator.share({ title, url });
					return;
				} catch (error) {
					// Người dùng đóng bảng chia sẻ: không phải lỗi.
					if (error && error.name === 'AbortError') return;
					// Lỗi khác (vd. NotAllowedError trong in-app browser): lùi về sao chép.
				}
			}
			await copyOrAskManual(url);
		} catch (error) {
			toast.error('Không thể chia sẻ link. Vui lòng thử lại');
		} finally {
			if (mountedRef.current) setWorking(false);
		}
	};

	const disabled = working || !path;
	const text = label || DEFAULT_LABELS[mode] || DEFAULT_LABELS.share;
	const busyText = mode === 'copy' ? 'Đang sao chép...' : 'Đang chia sẻ...';

	return (
		<>
			<button
				type="button"
				onClick={handleClick}
				disabled={disabled}
				title={!path ? disabledHint : undefined}
				className={`btn ${mode === 'copy' ? 'btn-secondary' : 'btn-primary'} ${className}`.trim()}
			>
				{working ? busyText : text}
			</button>
			{manualUrl && (
				<input
					ref={inputRef}
					type="text"
					readOnly
					value={manualUrl}
					aria-label="Link để sao chép"
					onFocus={(event) => event.target.select()}
					className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
				/>
			)}
		</>
	);
};

export default ShareButton;
