/*
 * FormField: label + required marker + input + error/hint, wired for a11y.
 *
 * <FormField id="email" label="Email" required error={errors.email} hint="...">
 *   <input name="email" className="form-input" ... />
 * </FormField>
 *
 * Props
 *   id        required; becomes the child's id and the label's htmlFor
 *   label     label text (node allowed)
 *   required  shows the red "*" after the label and sets aria-required on the child.
 *             Drive the validation rule from the same condition so they never disagree.
 *   error     message string; truthy -> red border/ring, aria-invalid, alert line
 *   hint      helper text under the field; stays visible below an error. It is only linked to the
 *             input (aria-describedby) while no error is shown, so a screen reader hears the error alone.
 *   hintVisualOnly  hint is decoration (e.g. a character counter): hidden from assistive tech and
 *             never referenced by aria-describedby
 *   children  exactly ONE input/select/textarea element (its own classes are kept)
 *
 * Pair with useFieldErrors (hooks/use-field-errors.js) for the error state.
 */
import React from 'react';

const ERROR_CLASSES = 'border-danger-500 ring-1 ring-danger-500 focus:border-danger-500 focus:ring-danger-500';

const FormField = ({ id, label, required = false, error, hint, hintVisualOnly = false, children }) => {
	const errorId = `${id}-error`;
	const hintId = `${id}-hint`;
	const child = React.Children.only(children);

	const describedBy = [child.props['aria-describedby'], error ? errorId : hint && !hintVisualOnly ? hintId : null]
		.filter(Boolean)
		.join(' ') || undefined;

	const field = React.cloneElement(child, {
		id,
		'aria-required': required ? 'true' : child.props['aria-required'],
		'aria-invalid': error ? 'true' : child.props['aria-invalid'],
		'aria-describedby': describedBy,
		className: [child.props.className, error ? ERROR_CLASSES : null].filter(Boolean).join(' ')
	});

	return (
		<div>
			<label htmlFor={id} className="block text-sm font-medium text-gray-700 mb-2">
				{label}
				{required && (
					<span className="text-danger-500 ms-1" aria-hidden="true">*</span>
				)}
			</label>
			{field}
			{error ? (
				<p id={errorId} role="alert" className="mt-1 text-sm text-danger-500">
					<i className="fas fa-exclamation-circle mr-1" aria-hidden="true"></i>
					{error}
				</p>
			) : hint ? (
				<p id={hintId} className="mt-1 text-sm text-gray-500" aria-hidden={hintVisualOnly ? 'true' : undefined}>{hint}</p>
			) : null}
		</div>
	);
};

export default FormField;
