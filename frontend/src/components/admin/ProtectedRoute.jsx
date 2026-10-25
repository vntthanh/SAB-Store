import React from 'react';
import { Navigate } from 'react-router-dom';
import { useSession } from '../../lib/auth-client';
import { canUseAdmin } from '../../lib/auth-flow';
import LoadingSpinner from '../LoadingSpinner';

const ProtectedRoute = ({ children }) => {
	const { data: session, isPending, error } = useSession();

	if (isPending) {
		return (
			<div className="min-h-screen flex items-center justify-center">
				<LoadingSpinner />
			</div>
		);
	}

	if (error || !session || !session.user || !canUseAdmin(session.user)) {
		return <Navigate to="/login" replace />;
	}

	return children;
};

export default ProtectedRoute;
