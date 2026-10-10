import React from 'react';
import ProductForm from './ProductForm';

const ProductModal = ({
	isOpen,
	onClose,
	product,
	onSubmit,
	onUploadImage
}) => {
	if (!isOpen) return null;

	return (
		<div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
			<div className="bg-white rounded-lg max-w-2xl w-full max-h-screen overflow-y-auto">
				<div className="p-6">
					<div className="flex justify-between items-center mb-6">
						<h2 className="text-xl font-semibold text-gray-900">
							{product ? 'Chỉnh sửa sản phẩm' : 'Thêm sản phẩm mới'}
						</h2>
						<button
							onClick={onClose}
							className="text-gray-500 hover:text-gray-700"
						>
							<i className="fas fa-times text-xl"></i>
						</button>
					</div>

					<ProductForm
						product={product}
						onSubmit={onSubmit}
						onCancel={onClose}
						onUploadImage={onUploadImage}
					/>
				</div>
			</div>
		</div>
	);
};

export default ProductModal;
