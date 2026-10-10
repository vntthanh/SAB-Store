import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from '../../lib/auth-client';
import LoadingSpinner from '../LoadingSpinner';

const SellerProtectedRoute = ({ children }) => {
	const location = useLocation();
	const { data: session, isPending, error } = useSession();

	if (isPending) {
		return (
			<div className="min-h-screen flex items-center justify-center">
				<LoadingSpinner />
			</div>
		);
	}

	if (error || !session || !session.user || (session.user.role !== 'seller' && session.user.role !== 'admin')) {
		// Redirect to seller login page with the current location
		return <Navigate to="/login" state={{ from: location }} replace />;
	}

	return children;
};

export default SellerProtectedRoute;
