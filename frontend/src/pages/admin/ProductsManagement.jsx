import React, { useState, useEffect, useRef } from 'react';
import { toast } from 'react-toastify';
import Swal from 'sweetalert2';
import { adminService } from '../../services/api';
import LoadingSpinner from '../../components/LoadingSpinner';
import ProductsTable from '../../components/admin/ProductsTable';
import ProductModal from '../../components/admin/ProductModal';
import StockAdjustPanel from '../../components/admin/StockAdjustPanel';
import StockMovementsTable from '../../components/admin/StockMovementsTable';
import StockReconcileModal from '../../components/admin/StockReconcileModal';
import StorefrontFilter from '../../components/admin/StorefrontFilter';
import useAdminStorefronts from '../../components/admin/use-admin-storefronts';
import { pickDefaultStorefrontId } from '../../components/admin/default-storefront';
import { describePage } from '../../utils/pagination';

const PAGE_SIZE = 20;

const StockModal = ({ product, onClose, onChanged }) => {
	const [refreshKey, setRefreshKey] = useState(0);

	const handleSubmitted = () => {
		setRefreshKey((k) => k + 1);
		onChanged();
	};

	return (
		<div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
			<div className="bg-white rounded-lg max-w-4xl w-full max-h-screen overflow-y-auto">
				<div className="p-6 space-y-6">
					<div className="flex justify-between items-start">
						<div>
							<h2 className="text-xl font-semibold text-gray-900">Tồn kho: {product.name}</h2>
							<p className="text-sm text-gray-600">
								Tồn hiện tại: <span className="font-semibold">{product.stockQuantity || 0}</span>
								{product.pendingMovements > 0 && (
									<span className="text-gray-500"> (đang cập nhật, còn {product.pendingMovements} biến động chưa áp)</span>
								)}
							</p>
						</div>
						<button type="button" onClick={onClose} className="text-gray-500 hover:text-gray-700">
							<i className="fas fa-times text-xl"></i>
						</button>
					</div>

					<StockAdjustPanel productId={product._id} onSubmitted={handleSubmitted} />
					<StockMovementsTable productId={product._id} refreshKey={refreshKey} />
				</div>
			</div>
		</div>
	);
};

const PageControls = ({ meta, disabled, onPage }) => {
	const { from, to, hasPrev, hasNext } = describePage(meta);

	return (
		<div className="bg-gray-50 px-6 py-3 border-t border-gray-200 flex items-center justify-between">
			<div className="text-sm text-gray-700">
				Hiển thị {from} đến {to} trong {meta.total} sản phẩm
			</div>
			<div className="flex items-center space-x-2">
				<button
					type="button"
					onClick={() => onPage(meta.page - 1)}
					disabled={disabled || !hasPrev}
					className="btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
				>
					<i className="fas fa-chevron-left"></i>
				</button>
				<span className="px-3 py-2 text-sm text-gray-700">
					Trang {meta.page} / {meta.totalPages}
				</span>
				<button
					type="button"
					onClick={() => onPage(meta.page + 1)}
					disabled={disabled || !hasNext}
					className="btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
				>
					<i className="fas fa-chevron-right"></i>
				</button>
			</div>
		</div>
	);
};

const ProductsManagement = () => {
	const [products, setProducts] = useState([]);
	const [loading, setLoading] = useState(true);
	const [showModal, setShowModal] = useState(false);
	const [editingProduct, setEditingProduct] = useState(null);
	const [stockProductId, setStockProductId] = useState(null);
	const [showReconcile, setShowReconcile] = useState(false);
	const [page, setPage] = useState(1);
	const [meta, setMeta] = useState(null);
	const [paging, setPaging] = useState(false);
	const [storefrontId, setStorefrontId] = useState('');
	const { storefronts, nameOf } = useAdminStorefronts();
	// A slow response for a previous page or filter must not overwrite the current one.
	const fetchSeqRef = useRef(0);

	// Fetch products
	// Turning a page keeps the table and the (disabled) controls on screen; only the first load shows the full spinner.
	useEffect(() => {
		fetchProducts({ silent: meta !== null });
	}, [page, storefrontId]);

	const fetchProducts = async ({ silent = false } = {}) => {
		let steppedBack = false;
		const seq = ++fetchSeqRef.current;
		try {
			if (!silent) setLoading(true);
			setPaging(true);
			const response = await adminService.getProducts({ page, limit: PAGE_SIZE, ...(storefrontId && { storefrontId }) });
			if (seq !== fetchSeqRef.current) return;
			if (response.success) {
				// The last row of the last page was deleted or moved: step back to a page that exists.
				if (response.data.length === 0 && page > 1 && response.meta.totalPages > 0) {
					// Keep loading/paging on: the [page] effect refetches, so the deleted row never flashes.
					steppedBack = true;
					setPage(response.meta.totalPages);
					return;
				}
				setProducts(response.data);
				setMeta(response.meta);
			}
		} catch (error) {
			if (seq !== fetchSeqRef.current) return;
			console.error('Error fetching products:', error);
			toast.error('Lỗi khi tải danh sách sản phẩm');
		} finally {
			if (!steppedBack && seq === fetchSeqRef.current) {
				setLoading(false);
				setPaging(false);
			}
		}
	};

	const handleEdit = (product) => {
		setEditingProduct(product);
		setShowModal(true);
	};

	const handleAddNew = () => {
		setEditingProduct(null);
		setShowModal(true);
	};

	const handleCloseModal = () => {
		setShowModal(false);
		setEditingProduct(null);
	};

	const handleSubmitProduct = async (productData) => {
		try {
			let response;
			if (editingProduct) {
				response = await adminService.updateProduct(editingProduct._id, productData);
			} else {
				response = await adminService.createProduct(productData);
			}

			if (response.success) {
				toast.success(editingProduct ? 'Cập nhật sản phẩm thành công' : 'Thêm sản phẩm thành công');
				handleCloseModal();
				fetchProducts();
			}
		} catch (error) {
			console.error('Error saving product:', error);
			toast.error(error.message || 'Lỗi khi lưu sản phẩm');
		}
	};

	const handleUploadImage = async (imageFile) => {
		return await adminService.uploadImage(imageFile);
	};

	const handleDelete = async (productId) => {
		const result = await Swal.fire({
			title: 'Xác nhận xóa sản phẩm',
			text: 'Bạn có chắc chắn muốn xóa sản phẩm này?',
			icon: 'warning',
			showCancelButton: true,
			confirmButtonColor: '#dc2626',
			cancelButtonColor: '#6b7280',
			confirmButtonText: 'Xóa',
			cancelButtonText: 'Hủy'
		});

		if (result.isConfirmed) {
			try {
				const response = await adminService.deleteProduct(productId);
				if (response.success) {
					toast.success('Xóa sản phẩm thành công');
					fetchProducts();
				}
			} catch (error) {
				console.error('Error deleting product:', error);
				toast.error('Lỗi khi xóa sản phẩm');
			}
		}
	};

	// Resolved by id so the modal shows fresh cached stock after each silent refetch.
	const stockProduct = products.find((p) => p._id === stockProductId) || null;

	if (loading) {
		return (
			<div className="flex items-center justify-center min-h-64">
				<LoadingSpinner size="large" text="Đang tải danh sách sản phẩm..." />
			</div>
		);
	}

	return (
		<div className="p-6">
			{/* Header */}
			<div className="flex justify-between items-center mb-6">
				<div>
					<h1 className="text-2xl font-bold text-gray-900">Quản lý sản phẩm</h1>
					<p className="text-gray-600">Thêm, sửa, xóa và quản lý sản phẩm</p>
				</div>
				<div className="flex items-center gap-3">
					<StorefrontFilter
						storefronts={storefronts}
						value={storefrontId}
						onChange={(value) => {
							setStorefrontId(value);
							setPage(1);
						}}
					/>
					<button
						onClick={() => setShowReconcile(true)}
						className="btn-secondary"
					>
						<i className="fas fa-balance-scale mr-2"></i>
						Đối soát tồn kho
					</button>
					<button
						onClick={handleAddNew}
						className="btn-primary"
					>
						<i className="fas fa-plus mr-2"></i>
						Thêm sản phẩm mới
					</button>
				</div>
			</div>

			{/* Products Table */}
			<div className="card">
				<ProductsTable
					products={products}
					storefrontName={nameOf}
					onEdit={handleEdit}
					onDelete={handleDelete}
					onManageStock={(product) => setStockProductId(product._id)}
				/>
				{meta && meta.totalPages > 1 && <PageControls meta={meta} disabled={paging} onPage={setPage} />}
			</div>

			{/* Modal */}
			<ProductModal
				isOpen={showModal}
				onClose={handleCloseModal}
				product={editingProduct}
				onSubmit={handleSubmitProduct}
				onUploadImage={handleUploadImage}
				storefronts={storefronts}
				defaultStorefrontId={storefrontId || pickDefaultStorefrontId(storefronts)}
			/>

			{stockProduct && (
				<StockModal
					product={stockProduct}
					onClose={() => setStockProductId(null)}
					onChanged={() => fetchProducts({ silent: true })}
				/>
			)}

			<StockReconcileModal isOpen={showReconcile} onClose={() => setShowReconcile(false)} />
		</div>
	);
};

export default ProductsManagement;
