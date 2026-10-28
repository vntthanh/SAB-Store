import React from 'react';
import { isValueAvailable } from '../../lib/variant-choice';

/**
 * One chip row per option. A chip stays disabled while no active variant has it together with the
 * other current picks; clicking the picked chip again clears it.
 */
const VariantPicker = ({ product, choice, onPick, disabled = false }) => (
	<div className="space-y-4 mb-6">
		{product.options.map((option, optionIndex) => (
			<fieldset key={option.name} className="min-w-0">
				<legend className="text-gray-700 mb-2">
					{option.name}
					{choice[optionIndex] && <span className="ml-2 font-medium text-gray-900">{choice[optionIndex]}</span>}
				</legend>
				<div className="flex flex-wrap gap-2">
					{option.values.map((value) => {
						const selected = choice[optionIndex] === value;
						const available = isValueAvailable(product, choice, optionIndex, value);
						return (
							<button
								key={value}
								type="button"
								aria-pressed={selected}
								disabled={disabled || !available}
								title={available ? undefined : 'Không có phân loại này với lựa chọn hiện tại'}
								onClick={() => onPick(optionIndex, value)}
								className={`px-4 py-2 rounded-lg border text-sm transition-colors break-words disabled:opacity-40 disabled:cursor-not-allowed disabled:line-through ${
									selected
										? 'border-primary-600 bg-primary-50 text-primary-700 font-semibold'
										: 'border-gray-300 text-gray-700 hover:border-primary-400'
								}`}
							>
								{value}
							</button>
						);
					})}
				</div>
			</fieldset>
		))}
	</div>
);

export default VariantPicker;
