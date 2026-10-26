import React from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthIdentity } from '../lib/use-storefronts';
import { landingPath } from '../lib/auth-flow';
import LoadingSpinner from '../components/LoadingSpinner';
import LoginPanel from '../components/auth/LoginPanel';
import Logo from '../components/Logo';

// Where to go after signing in: ?next= wins, else the page a protected route bounced from.
// landingPath re-checks it is a same-origin path, so an external URL is never followed.
const useNextTarget = () => {
	const [searchParams] = useSearchParams();
	const location = useLocation();
	const from = location.state?.from;
	return searchParams.get('next') ?? (from?.pathname ? `${from.pathname}${from.search ?? ''}` : null);
};

const LoginPage = () => {
	const navigate = useNavigate();
	const next = useNextTarget();
	const { ready, user } = useAuthIdentity();

	if (!ready) {
		return (
			<div className="min-h-screen flex items-center justify-center">
				<LoadingSpinner />
			</div>
		);
	}

	// Already signed in: nothing to ask, go where the role belongs.
	if (user) {
		return <Navigate to={landingPath({ user, next })} replace />;
	}

	return (
		<div className="min-h-screen bg-gray-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
			<div className="sm:mx-auto sm:w-full sm:max-w-md">
				<div className="text-center">
					<Link to="/" className="inline-flex items-center text-2xl font-bold text-primary-600 hover:text-primary-700">
						<Logo />
					</Link>
				</div>
			</div>

			<div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
				<div className="card">
					<div className="px-6 py-8">
						<LoginPanel
							title="Đăng nhập"
							hint="Khách hàng đăng nhập bằng Google hoặc mã gửi qua email. Tài khoản nội bộ có thể dùng mật khẩu."
							onSignedIn={(session) => navigate(landingPath({ user: session.user, next }), { replace: true })}
						/>
					</div>
				</div>

				<div className="mt-6 text-center">
					<Link to="/" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
						<i className="fas fa-arrow-left mr-1"></i>
						Quay về trang chủ
					</Link>
				</div>
			</div>
		</div>
	);
};

export default LoginPage;
