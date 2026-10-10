import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { adminService, comboService, productService, formatCurrency, formatDate } from '../../services/api';
import { getOrderChannel, isFinalOrderStatus } from '../../utils/order-status';
import useFieldErrors from '../../hooks/use-field-errors';
import FormField from '../form/FormField';
import { orderItemsEdit } from '@sab/shared';
import { rulesFromSchema, requiredFromSchema, leftoverIssues } from '../../lib/schema-rules';

const PREVIEW_DEBOUNCE_MS = 300;
const MAX_REASON_LENGTH = 200;
const MAX_LINES = 50;

const lineProductId = (item) => String(item.productId?._id || item.productId);

// An order can hold the same product as a combo line and as a loose line; the
// server prices units per product, so the draft works on one line per product.
const toDraft = (items) => {
	const byProduct = new Map();
	(items || []).forEach((item) => {
		const productId = lineProductId(item);
		const existing = byProduct.get(productId);
		if (existing) existing.quantity += item.quantity;
		else byProduct.set(productId, { productId, productName: item.productName, quantity: item.quantity });
	});
	return [...byProduct.values()];
};

const draftSignature = (draft) =>
	draft
		.map((line) => `${line.productId}:${line.quantity}`)
		.sort()
		.join('|');

// The reason is the only part of the edit schema the user types; the items and the revision come
// from the draft and the order, and are checked again in handleSave.
const REASON_RULES = rulesFromSchema(orderItemsEdit, { fields: ['reason'] });
const REQUIRED = requiredFromSchema(orderItemsEdit);

// Its own component so the error state disappears with the edit session instead of
// resurfacing the next time editing opens. Save stays disabled until the reason
// is filled, so the message appears on blur rather than on submit.
const ReasonField = ({ value, onChange, disabled }) => {
	const { errors, validateField, onFieldChange } = useFieldErrors(REASON_RULES);
	return (
		<FormField id="order-items-reason" label="Lý do sửa" required={REQUIRED.reason} error={errors.reason}>
			<input
				type="text"
				className="w-full border rounded px-3 py-2 text-sm"
				maxLength={MAX_REASON_LENGTH}
				value={value}
				onChange={(e) => {
					onChange(e.target.value);
					onFieldChange('reason', e.target.value);
				}}
				onBlur={() => validateField('reason', value)}
				disabled={disabled}
			/>
		</FormField>
	);
};

const OrderItemsEditor = ({ order, onSaved, onReload }) => {
	const channel = getOrderChannel(order);
	const canEdit = !isFinalOrderStatus(order.status);
	const revision = order.itemsRevision ?? 0;

	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState([]);
	const [reason, setReason] = useState('');
	const [saving, setSaving] = useState(false);
	const [preview, setPreview] = useState({ state: 'idle' });
	const [previewNonce, setPreviewNonce] = useState(0);
	const [products, setProducts] = useState([]);
	const [productsLoading, setProductsLoading] = useState(false);
	const [search, setSearch] = useState('');
	const previewRequestId = useRef(0);

	const originalDraft = useMemo(() => toDraft(order.items), [order.items]);
	const hasChanges = draftSignature(draft) !== draftSignature(originalDraft);

	// A different order, or one that became final, never keeps a draft open.
	useEffect(() => {
		setEditing(false);
		setReason('');
		setSearch('');
	}, [order._id]);

	useEffect(() => {
		if (!canEdit) setEditing(false);
	}, [canEdit]);

	// Sellable list depends on the order's channel; load it only when editing starts.
	useEffect(() => {
		if (!editing) return undefined;
		let cancelled = false;
		// Drop the previous channel's list so it is never offered while this one loads.
		setProducts([]);
		setProductsLoading(true);
		const load = channel === 'offline' ? productService.getDirectSalesProducts : productService.getProducts;
		load()
			.then((response) => {
				if (!cancelled) setProducts(response.data?.products || []);
			})
			.catch((error) => {
				if (!cancelled) toast.error(error.message || 'Lỗi khi tải danh sách sản phẩm');
			})
			.finally(() => {
				if (!cancelled) setProductsLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [editing, channel]);

	// Debounced preview. The request id drops responses that a newer edit overtook.
	useEffect(() => {
		if (!editing) return undefined;
		if (draft.length === 0) {
			previewRequestId.current += 1;
			setPreview({ state: 'empty' });
			return undefined;
		}

		setPreview({ state: 'loading' });
		const requestId = ++previewRequestId.current;
		const timer = setTimeout(async () => {
			try {
				const items = draft.map(({ productId, quantity }) => ({ productId, quantity }));
				const result = await comboService.calculatePricing(items, { channel });
				if (requestId !== previewRequestId.current) return;
				if (result.success && typeof result.data?.totalAmount === 'number') {
					setPreview({ state: 'ok', total: result.data.totalAmount, signature: draftSignature(draft) });
				} else {
					setPreview({ state: 'error', message: result.message || 'Không tính được giá' });
				}
			} catch (error) {
				if (requestId !== previewRequestId.current) return;
				setPreview({ state: 'error', message: error.message || 'Không tính được giá' });
			}
		}, PREVIEW_DEBOUNCE_MS);

		return () => {
			clearTimeout(timer);
			// Also covers unmount: a late response must not set state.
			previewRequestId.current += 1;
		};
	}, [editing, draft, channel, previewNonce]);

	const startEditing = () => {
		setDraft(toDraft(order.items));
		setReason('');
		setSearch('');
		setEditing(true);
	};

	const cancelEditing = () => {
		setEditing(false);
		setReason('');
		setSearch('');
	};

	const changeQuantity = (productId, delta) => {
		setDraft((prev) =>
			prev.map((line) =>
				line.productId === productId ? { ...line, quantity: Math.max(1, line.quantity + delta) } : line
			)
		);
	};

	const removeLine = (productId) => {
		setDraft((prev) => prev.filter((line) => line.productId !== productId));
	};

	const addProduct = (product) => {
		const productId = String(product._id);
		setDraft((prev) => {
			if (prev.some((line) => line.productId === productId)) {
				return prev.map((line) => (line.productId === productId ? { ...line, quantity: line.quantity + 1 } : line));
			}
			if (prev.length >= MAX_LINES) return prev;
			return [...prev, { productId, productName: product.name, quantity: 1 }];
		});
	};

	const filteredProducts = useMemo(() => {
		const term = search.trim().toLowerCase();
		if (!term) return products;
		return products.filter((product) => (product.name || '').toLowerCase().includes(term));
	}, [products, search]);

	const trimmedReason = reason.trim();
	// The preview must belong to the current draft: right after an edit the old
	// 'ok' preview is still in state for one render, before the effect marks it loading.
	const totalMatches = preview.state === 'ok'
		&& preview.signature === draftSignature(draft)
		&& preview.total === order.totalAmount;
	const canSave = hasChanges && totalMatches && trimmedReason.length > 0 && !saving;

	const handleSave = useCallback(async () => {
		const payload = {
			items: draft.map(({ productId, quantity }) => ({ productId, quantity })),
			expectedRevision: revision,
			reason: trimmedReason,
		};
		// The reason is shown under its input; anything else the schema rejects has no field.
		const unplaced = leftoverIssues(orderItemsEdit, payload, ['reason']);
		if (unplaced.length > 0) {
			toast.error(unplaced.map(({ message }) => message).join('. '));
			return;
		}

		setSaving(true);
		try {
			const response = await adminService.updateOrderItems(order._id, payload);
			toast.success(response.unchanged ? 'Không có thay đổi nào cần lưu' : response.message || 'Đã lưu sản phẩm trong đơn');
			setEditing(false);
			setReason('');
			setSearch('');
			if (response.data) onSaved(response.data);
		} catch (error) {
			if (error.code === 'ORDER_TOTAL_CHANGED') {
				const { expected, actual } = error.details || {};
				toast.error(
					expected !== undefined && actual !== undefined
						? `Tổng tiền phải giữ ${formatCurrency(expected)}, bộ sản phẩm mới tính ra ${formatCurrency(actual)}`
						: error.message
				);
				// Prices may have moved since the preview; recompute it.
				setPreviewNonce((n) => n + 1);
			} else if (error.code === 'ORDER_CHANGED' || error.code === 'ORDER_FINAL') {
				toast.warn(error.message || 'Đơn vừa được cập nhật, đã tải lại');
				// The draft stays; only the order (revision, status) is refreshed.
				if (onReload) await onReload();
			} else if (error.fieldErrors?.length) {
				toast.error(error.fieldErrors.map(({ message }) => message).join('. '));
			} else {
				toast.error(error.message || 'Lỗi khi lưu sản phẩm trong đơn');
			}
		} finally {
			setSaving(false);
		}
	}, [order._id, draft, revision, trimmedReason, onSaved, onReload]);

	const history = order.itemsHistory || [];

	const renderPreview = () => {
		if (preview.state === 'loading') return <span className="text-gray-500">Đang tính giá…</span>;
		if (preview.state === 'empty') return <span className="text-gray-500">Đơn cần ít nhất một sản phẩm</span>;
		if (preview.state === 'error') return <span className="text-red-600">{preview.message}</span>;
		if (preview.state !== 'ok') return null;
		const diff = preview.total - order.totalAmount;
		return (
			<span className={totalMatches ? 'text-green-700' : 'text-red-600'}>
				Tổng mới {formatCurrency(preview.total)} · Tổng đơn {formatCurrency(order.totalAmount)} · Chênh{' '}
				{diff > 0 ? '+' : ''}
				{formatCurrency(diff)}
			</span>
		);
	};

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<p className="block text-sm font-medium text-gray-700">Sản phẩm trong đơn</p>
				{canEdit && !editing && (
					<button type="button" onClick={startEditing} className="btn btn-secondary px-3 py-1.5 text-sm">
						Sửa sản phẩm
					</button>
				)}
			</div>

			{!editing && (
				<ul className="bg-gray-50 border rounded divide-y">
					{(order.items || []).map((item, index) => (
						<li key={index} className="px-3 py-2 text-sm flex items-center justify-between gap-2">
							<span className="text-gray-900">
								{item.productName} × {item.quantity}
								{item.fromCombo && item.comboName && (
									<span className="ml-2 text-xs text-gray-500">({item.comboName})</span>
								)}
							</span>
							<span className="text-gray-600 whitespace-nowrap">{formatCurrency(item.price * item.quantity)}</span>
						</li>
					))}
				</ul>
			)}

			{editing && (
				<div className="space-y-3">
					<ul className="bg-gray-50 border rounded divide-y">
						{draft.length === 0 && <li className="px-3 py-2 text-sm text-gray-500">Chưa có sản phẩm nào</li>}
						{draft.map((line) => (
							<li key={line.productId} className="px-3 py-2 text-sm flex items-center justify-between gap-2">
								<span className="text-gray-900">{line.productName}</span>
								<span className="flex items-center gap-2">
									<button
										type="button"
										aria-label={`Giảm số lượng ${line.productName}`}
										onClick={() => changeQuantity(line.productId, -1)}
										disabled={saving || line.quantity <= 1}
										className="w-8 h-8 border rounded disabled:opacity-50 disabled:cursor-not-allowed"
									>
										−
									</button>
									<span className="w-8 text-center">{line.quantity}</span>
									<button
										type="button"
										aria-label={`Tăng số lượng ${line.productName}`}
										onClick={() => changeQuantity(line.productId, 1)}
										disabled={saving}
										className="w-8 h-8 border rounded disabled:opacity-50 disabled:cursor-not-allowed"
									>
										+
									</button>
									<button
										type="button"
										onClick={() => removeLine(line.productId)}
										disabled={saving}
										aria-label={`Xoá ${line.productName || 'sản phẩm'}`}
										className="h-8 px-2 text-red-600 border border-red-200 rounded disabled:opacity-50 disabled:cursor-not-allowed"
									>
										Xoá
									</button>
								</span>
							</li>
						))}
					</ul>

					<div>
						<label className="block text-xs text-gray-600 mb-1" htmlFor="order-items-search">
							Thêm sản phẩm
						</label>
						<input
							id="order-items-search"
							type="text"
							className="w-full border rounded px-3 py-2 text-sm"
							placeholder="Tìm sản phẩm…"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							disabled={saving}
						/>
						<ul className="mt-1 max-h-48 overflow-y-auto border rounded divide-y">
							{productsLoading && <li className="px-3 py-2 text-sm text-gray-500">Đang tải sản phẩm…</li>}
							{!productsLoading && filteredProducts.length === 0 && (
								<li className="px-3 py-2 text-sm text-gray-500">Không có sản phẩm phù hợp</li>
							)}
							{filteredProducts.map((product) => (
								<li key={product._id}>
									<button
										type="button"
										onClick={() => addProduct(product)}
										disabled={saving}
										className="w-full px-3 py-2 text-sm flex items-center justify-between gap-2 text-left hover:bg-gray-50 disabled:opacity-50"
									>
										<span>{product.name}</span>
										{typeof product.price === 'number' && (
											<span className="text-gray-500 whitespace-nowrap">{formatCurrency(product.price)}</span>
										)}
									</button>
								</li>
							))}
						</ul>
					</div>

					<p className="text-sm font-medium" aria-live="polite">
						{renderPreview()}
					</p>

					<ReasonField value={reason} onChange={setReason} disabled={saving} />

					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={cancelEditing}
							disabled={saving}
							className="btn btn-secondary px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
						>
							Huỷ thay đổi
						</button>
						<button
							type="button"
							onClick={handleSave}
							disabled={!canSave}
							className="btn btn-primary px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{saving ? 'Đang lưu…' : 'Lưu'}
						</button>
					</div>
				</div>
			)}

			{history.length > 0 && (
				<div>
					<p className="text-xs text-gray-600 mb-1">Lịch sử sửa sản phẩm</p>
					<ul className="space-y-2">
						{history.map((entry, index) => (
							<li key={index} className="text-sm bg-yellow-50 border border-yellow-200 rounded px-3 py-2">
								<div className="text-gray-900 whitespace-pre-wrap">{entry.reason}</div>
								<div className="text-xs text-gray-500 mt-1">
									{entry.editedBy} • {formatDate(entry.editedAt)}
								</div>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
};

export default OrderItemsEditor;
