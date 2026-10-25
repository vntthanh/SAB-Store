import React from 'react';

const OTP_LENGTH = 6;

const digitsOnly = (text) => String(text ?? '').replace(/\D/g, '').slice(0, OTP_LENGTH);

// One native input holds the whole code, so paste, delete and one-time-code
// autofill act on the code as a unit. The boxes only draw it; the caret is
// never repositioned, because Vietnamese input methods delete by selecting the
// previous character and a forced caret leaves them nothing to delete.
const OtpInput = ({ value = '', onChange, id, disabled = false, autoFocus = false, invalid = false }) => {
	const code = digitsOnly(value);
	const [focused, setFocused] = React.useState(false);
	const activeIndex = Math.min(code.length, OTP_LENGTH - 1);

	return (
		<div className="relative inline-flex gap-2">
			{Array.from({ length: OTP_LENGTH }, (_, index) => (
				<div
					key={index}
					aria-hidden="true"
					className={[
						'flex h-12 w-10 items-center justify-center rounded-lg border bg-white font-mono text-xl text-gray-900 sm:w-11',
						invalid ? 'border-danger-500' : 'border-gray-300',
						focused && index === activeIndex ? 'ring-2 ring-primary-500 border-primary-500' : '',
						disabled ? 'bg-gray-100 text-gray-400' : '',
					].join(' ')}
				>
					{code[index] ?? ''}
				</div>
			))}
			<input
				id={id}
				value={code}
				onChange={(event) => onChange?.(digitsOnly(event.target.value))}
				onPaste={(event) => {
					event.preventDefault();
					const pasted = digitsOnly(event.clipboardData.getData('text'));
					if (pasted) onChange?.(pasted);
				}}
				onFocus={() => setFocused(true)}
				onBlur={() => setFocused(false)}
				aria-label="Mã xác thực 6 chữ số"
				aria-invalid={invalid ? 'true' : undefined}
				inputMode="numeric"
				autoComplete="one-time-code"
				autoFocus={autoFocus}
				disabled={disabled}
				spellCheck={false}
				// Below 16px iOS zooms the page on focus.
				className="absolute inset-0 h-full w-full cursor-text opacity-0"
				style={{ fontSize: 16 }}
			/>
		</div>
	);
};

export default OtpInput;
