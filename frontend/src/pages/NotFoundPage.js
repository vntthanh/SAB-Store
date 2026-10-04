import React from 'react';
import { Link } from 'react-router-dom';

const NotFoundPage = ({ message = 'Sản phẩm không tồn tại hoặc trang không tồn tại' }) => (
	<div className="container mx-auto px-4 py-16 text-center">
		<i className="fas fa-box-open text-6xl text-gray-300 mb-4"></i>
		<h1 className="text-2xl font-bold text-gray-900 mb-2">Không tìm thấy trang</h1>
		<p className="text-gray-600 mb-6">{message}</p>
		<Link to="/" className="btn btn-primary inline-flex items-center">
			Về cửa hàng
		</Link>
	</div>
);

export default NotFoundPage;
