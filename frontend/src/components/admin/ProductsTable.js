import React from 'react';
import { formatCurrency, getImageUrl } from '../../utils/helpers';
import { SALES_CHANNEL_LABELS, normalizeSalesChannel } from '../../utils/sales-channel';

const ProductsTable = ({ products, onEdit, onDelete, onManageStock }) => {
	if (products.length === 0) {
		return (
			<div className="text-center py-12">
				<i className="fas fa-box-open text-6xl text-gray-300 mb-4"></i>
				<h3 className="text-lg font-semibold text-gray-900 mb-2">Chưa có sản phẩm</h3>
				<p className="text-gray-600">Thêm sản phẩm đầu tiên để bắt đầu</p>
			</div>
		);
	}

	return (
		<div className="overflow-x-auto">
			<table className="min-w-full divide-y divide-gray-200">
				<thead className="bg-gray-50">
					<tr>
						<th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
							Sản phẩm
						</th>
						<th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
							Danh mục
						</th>
						<th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
							Giá
						</th>
						<th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
							Tồn kho
						</th>
						<th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
							Trạng thái
						</th>
						<th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
							Hành động
						</th>
					</tr>
				</thead>
				<tbody className="bg-white divide-y divide-gray-200">
					{products.map((product) => (
						<tr key={product._id} className="hover:bg-gray-50">
							<td className="px-6 py-4">
								<div className="flex items-center">
									<img
										src={getImageUrl(product.imageUrl)}
										alt={product.name}
										className="w-16 h-16 object-cover rounded-lg mr-4"
										onError={(e) => {
											e.target.src = '/fallback-product.png';
										}}
									/>
									<div>
										<div className="text-sm font-medium text-gray-900">
											{product.name}
										</div>
										<div className="text-sm text-gray-500 line-clamp-2">
											{product.description}
										</div>
									</div>
								</div>
							</td>
							<td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
								{product.category}
							</td>
							<td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-gray-900">
								{formatCurrency(product.price)}
							</td>
							<td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
								<span className={`${product.stockQuantity <= 5 ? 'text-danger-600 font-semibold' : 'text-gray-900'}`}>
									{product.stockQuantity || 0} sản phẩm
								</span>
								{product.pendingMovements > 0 && (
									<div className="text-xs text-gray-500">đang cập nhật</div>
								)}
							</td>
							<td className="px-6 py-4 whitespace-nowrap">
								<span className={`badge ${product.available ? 'badge-success' : 'badge-danger'}`}>
									{product.available ? 'Đang bán' : 'Ngừng bán'}
								</span>
								{product.available && normalizeSalesChannel(product.salesChannel) !== 'all' && (
									<span className="badge badge-primary ml-2">
										{SALES_CHANNEL_LABELS[normalizeSalesChannel(product.salesChannel)]}
									</span>
								)}
							</td>
							<td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
								<button
									onClick={() => onManageStock(product)}
									className="text-gray-700 hover:text-gray-900 mr-3"
								>
									<i className="fas fa-boxes mr-1"></i>
									Tồn kho
								</button>
								<button
									onClick={() => onEdit(product)}
									className="text-primary-600 hover:text-primary-900 mr-3"
								>
									<i className="fas fa-edit mr-1"></i>
									Sửa
								</button>
								<button
									onClick={() => onDelete(product._id)}
									className="text-danger-600 hover:text-danger-900"
								>
									<i className="fas fa-trash mr-1"></i>
									Xóa
								</button>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
};

export default ProductsTable;
