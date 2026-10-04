import React, { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { getStockMovements } from '../../services/stock-api';
import { formatDate } from '../../utils/helpers';
import LoadingSpinner from '../LoadingSpinner';

const PAGE_SIZE = 10;

const TYPE_LABELS = {
	opening: 'Tồn đầu',
	order: 'Đơn hàng',
	order_cancel: 'Huỷ đơn',
	adjust: 'Thêm/bớt',
	set_target: 'Đặt tồn'
};

const formatDelta = (movement) => {
	if (movement.delta === null || movement.delta === undefined) {
		// set_target stays unresolved until the worker computes the delta.
		return movement.target !== null && movement.target !== undefined ? `→ ${movement.target}` : '—';
	}
	return movement.delta > 0 ? `+${movement.delta}` : String(movement.delta);
};

// `refreshKey` lets the parent re-fetch after a new adjustment is recorded.
const StockMovementsTable = ({ productId, refreshKey = 0 }) => {
	const [page, setPage] = useState(1);
	const [items, setItems] = useState([]);
	const [pagination, setPagination] = useState(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		setPage(1);
	}, [productId]);

	useEffect(() => {
		let cancelled = false;
		const load = async () => {
			setLoading(true);
			try {
				const response = await getStockMovements(productId, { page, limit: PAGE_SIZE });
				if (cancelled) return;
				setItems(response.data?.items || []);
				setPagination(response.data?.pagination || null);
			} catch (error) {
				if (!cancelled) toast.error(error.message);
			} finally {
				if (!cancelled) setLoading(false);
			}
		};
		load();
		return () => {
			cancelled = true;
		};
	}, [productId, page, refreshKey]);

	const totalPages = pagination?.totalPages ?? pagination?.pages ?? 1;

	return (
		<div>
			<h3 className="text-sm font-semibold text-gray-900 mb-2">Lịch sử tồn kho</h3>

			{loading ? (
				<div className="py-8 flex justify-center">
					<LoadingSpinner text="Đang tải lịch sử..." />
				</div>
			) : items.length === 0 ? (
				<p className="text-sm text-gray-500 py-6 text-center">Chưa có biến động tồn kho</p>
			) : (
				<div className="overflow-x-auto">
					<table className="min-w-full divide-y divide-gray-200 text-sm">
						<thead className="bg-gray-50">
							<tr>
								{['Loại', 'Delta', 'Tồn sau', 'Trạng thái', 'Lý do', 'Người', 'Thời điểm', 'Đơn liên quan'].map((h) => (
									<th key={h} className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
										{h}
									</th>
								))}
							</tr>
						</thead>
						<tbody className="bg-white divide-y divide-gray-200">
							{items.map((m) => (
								<tr key={m._id}>
									<td className="px-3 py-2 whitespace-nowrap">{TYPE_LABELS[m.type] || m.type}</td>
									<td className={`px-3 py-2 whitespace-nowrap font-semibold ${m.delta < 0 ? 'text-danger-600' : m.delta > 0 ? 'text-success-600' : 'text-gray-500'}`}>
										{formatDelta(m)}
									</td>
									<td className="px-3 py-2 whitespace-nowrap">{m.stockAfter ?? '—'}</td>
									<td className="px-3 py-2 whitespace-nowrap">
										<span className={`badge ${m.status === 'applied' ? 'badge-success' : 'badge-warning'}`}>
											{m.status === 'applied' ? 'Đã áp' : 'Đang áp'}
										</span>
									</td>
									<td className="px-3 py-2 max-w-xs break-words">{m.reason || '—'}</td>
									<td className="px-3 py-2 whitespace-nowrap">{m.createdBy || '—'}</td>
									<td className="px-3 py-2 whitespace-nowrap">{formatDate(m.createdAt)}</td>
									<td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
										{m.orderId ? String(m.orderId).slice(-8) : '—'}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			{totalPages > 1 && (
				<div className="flex items-center justify-end gap-2 mt-3">
					<button
						type="button"
						className="btn-secondary"
						disabled={loading || page <= 1}
						onClick={() => setPage((p) => p - 1)}
					>
						Trước
					</button>
					<span className="text-sm text-gray-600">
						Trang {page} / {totalPages}
					</span>
					<button
						type="button"
						className="btn-secondary"
						disabled={loading || page >= totalPages}
						onClick={() => setPage((p) => p + 1)}
					>
						Sau
					</button>
				</div>
			)}
		</div>
	);
};

export default StockMovementsTable;
