import React from 'react';
import { validatePassword, getStrengthColor, getStrengthText, PASSWORD_STRENGTH, MIN_PASSWORD_LENGTH } from '../utils/passwordValidator';

const PasswordStrengthIndicator = ({ password, showRequirements = true }) => {
	const validation = validatePassword(password);

	if (!password) {
		return null;
	}

	return (
		<div className="mt-2 space-y-2">
			{/* Strength Bar */}
			<div className="space-y-1">
				<div className="flex justify-between items-center">
					<span className="text-xs text-gray-600">Độ mạnh mật khẩu:</span>
					<span className={`text-xs font-medium ${getStrengthColor(validation.strength)}`}>
						{getStrengthText(validation.strength)}
					</span>
				</div>
				<div className="w-full bg-gray-200 rounded-full h-2">
					<div
						className={`h-2 rounded-full transition-all duration-300 ${validation.strength === PASSWORD_STRENGTH.WEAK ? 'bg-red-500 w-1/3' :
								validation.strength === PASSWORD_STRENGTH.MEDIUM ? 'bg-yellow-500 w-2/3' :
									validation.strength === PASSWORD_STRENGTH.STRONG ? 'bg-green-500 w-full' :
										'bg-gray-300 w-0'
							}`}
					/>
				</div>
			</div>

			{/* Requirements Checklist */}
			{showRequirements && (
				<div className="space-y-1">
					<RequirementItem
						met={validation.requirements.length}
						text={`Ít nhất ${MIN_PASSWORD_LENGTH} ký tự`}
					/>
					<RequirementItem
						met={validation.requirements.lowercase}
						text="Chứa chữ cái thường (a-z)"
					/>
					<RequirementItem
						met={validation.requirements.uppercase}
						text="Chứa chữ cái hoa (A-Z)"
					/>
					<RequirementItem
						met={validation.requirements.notCommon}
						text="Không phải mật khẩu thường dùng"
					/>
				</div>
			)}

			{/* Error Messages */}
			{validation.errors.length > 0 && (
				<div className="space-y-1">
					{validation.errors.map((error, index) => (
						<div key={index} className="text-xs text-red-600 flex items-center">
							<i className="fas fa-exclamation-circle mr-1" />
							{error}
						</div>
					))}
				</div>
			)}
		</div>
	);
};

const RequirementItem = ({ met, text }) => (
	<div className={`text-xs flex items-center ${met ? 'text-green-600' : 'text-gray-400'}`}>
		<i className={`fas ${met ? 'fa-check-circle' : 'fa-circle'} mr-2 text-xs`} />
		{text}
	</div>
);

export default PasswordStrengthIndicator;
