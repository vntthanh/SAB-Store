import React, { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { getStockReconcile } from '../../services/stock-api';
import LoadingSpinner from '../LoadingSpinner';

const StockReconcileModal = ({ isOpen, onClose }) => {
	const [rows, setRows] = useState([]);
	const [loading, setLoading] = useState(false);
	const [onlyDiff, setOnlyDiff] = useState(true);

	useEffect(() => {
		if (!isOpen) return undefined;
		let cancelled = false;
		const load = async () => {
			setLoading(true);
			try {
				const response = await getStockReconcile();
				if (!cancelled) setRows(response.data || []);
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
	}, [isOpen]);

	if (!isOpen) return null;

	const diffCount = rows.filter((r) => r.diff !== 0).length;
	const visible = onlyDiff ? rows.filter((r) => r.diff !== 0) : rows;

	return (
		<div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
			<div className="bg-white rounded-lg max-w-3xl w-full max-h-screen overflow-y-auto">
				<div className="p-6">
					<div className="flex justify-between items-center mb-4">
						<h2 className="text-xl font-semibold text-gray-900">Đối soát tồn kho</h2>
						<button type="button" onClick={onClose} className="text-gray-500 hover:text-gray-700">
							<i className="fas fa-times text-xl"></i>
						</button>
					</div>

					<p className="text-sm text-gray-600 mb-3">
						So tồn đang lưu với tổng các biến động đã áp. Sửa lệch bằng điều chỉnh tồn kho của từng sản phẩm.
					</p>

					<label className="inline-flex items-center text-sm text-gray-700 mb-3">
						<input
							type="checkbox"
							checked={onlyDiff}
							onChange={(e) => setOnlyDiff(e.target.checked)}
							className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
						/>
						<span className="ml-2">Chỉ hiện sản phẩm bị lệch ({diffCount})</span>
					</label>

					{loading ? (
						<div className="py-8 flex justify-center">
							<LoadingSpinner text="Đang đối soát..." />
						</div>
					) : visible.length === 0 ? (
						<p className="text-sm text-gray-500 py-6 text-center">
							{onlyDiff ? 'Không có sản phẩm nào bị lệch' : 'Chưa có dữ liệu'}
						</p>
					) : (
						<div className="overflow-x-auto">
							<table className="min-w-full divide-y divide-gray-200 text-sm">
								<thead className="bg-gray-50">
									<tr>
										{['Sản phẩm', 'Tồn lưu', 'Tổng biến động', 'Lệch', 'Đang áp'].map((h) => (
											<th key={h} className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
												{h}
											</th>
										))}
									</tr>
								</thead>
								<tbody className="bg-white divide-y divide-gray-200">
									{visible.map((r) => (
										<tr key={r.productId} className={r.diff !== 0 ? 'bg-danger-50' : ''}>
											<td className="px-3 py-2">{r.name}</td>
											<td className="px-3 py-2 whitespace-nowrap">{r.cached}</td>
											<td className="px-3 py-2 whitespace-nowrap">{r.ledgerSum}</td>
											<td className={`px-3 py-2 whitespace-nowrap ${r.diff !== 0 ? 'text-danger-600 font-semibold' : ''}`}>
												{r.diff > 0 ? `+${r.diff}` : r.diff}
											</td>
											<td className="px-3 py-2 whitespace-nowrap">{r.pending || 0}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}

					<div className="flex justify-end pt-4">
						<button type="button" onClick={onClose} className="btn-secondary">
							Đóng
						</button>
					</div>
				</div>
			</div>
		</div>
	);
};

export default StockReconcileModal;
