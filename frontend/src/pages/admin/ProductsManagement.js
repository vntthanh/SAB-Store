import React, { useState, useEffect } from 'react';
import { toast } from 'react-toastify';
import Swal from 'sweetalert2';
import { adminService } from '../../services/api';
import LoadingSpinner from '../../components/LoadingSpinner';
import ProductsTable from '../../components/admin/ProductsTable';
import ProductModal from '../../components/admin/ProductModal';
import StockAdjustPanel from '../../components/admin/StockAdjustPanel';
import StockMovementsTable from '../../components/admin/StockMovementsTable';
import StockReconcileModal from '../../components/admin/StockReconcileModal';

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

const ProductsManagement = () => {
	const [products, setProducts] = useState([]);
	const [loading, setLoading] = useState(true);
	const [showModal, setShowModal] = useState(false);
	const [editingProduct, setEditingProduct] = useState(null);
	const [stockProductId, setStockProductId] = useState(null);
	const [showReconcile, setShowReconcile] = useState(false);

	// Fetch products
	useEffect(() => {
		fetchProducts();
	}, []);

	const fetchProducts = async ({ silent = false } = {}) => {
		try {
			if (!silent) setLoading(true);
			const response = await adminService.getProducts();
			if (response.success) {
				setProducts(response.data.products);
			}
		} catch (error) {
			console.error('Error fetching products:', error);
			toast.error('Lỗi khi tải danh sách sản phẩm');
		} finally {
			setLoading(false);
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
			toast.error('Lỗi khi lưu sản phẩm');
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
					onEdit={handleEdit}
					onDelete={handleDelete}
					onManageStock={(product) => setStockProductId(product._id)}
				/>
			</div>

			{/* Modal */}
			<ProductModal
				isOpen={showModal}
				onClose={handleCloseModal}
				product={editingProduct}
				onSubmit={handleSubmitProduct}
				onUploadImage={handleUploadImage}
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
