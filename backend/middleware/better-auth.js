const { auth } = require('../lib/auth');

/**
 * Authentication middleware using better-auth
 */
const authenticateUser = async (req, res, next) => {
	try {
		const session = await auth.api.getSession({
			headers: req.headers,
		});

		if (!session) {
			return res.status(401).json({
				success: false,
				message: 'Không có session xác thực, truy cập bị từ chối'
			});
		}

		// Add user and session to request
		req.user = session.user;
		req.session = session;
		next();
	} catch (error) {
		console.error('Auth middleware error:', error);
		return res.status(401).json({
			success: false,
			message: 'Xác thực thất bại'
		});
	}
};

/**
 * Authentication middleware for admin routes
 */
const authenticateAdmin = async (req, res, next) => {
	try {
		const session = await auth.api.getSession({
			headers: req.headers,
		});

		if (!session) {
			return res.status(401).json({
				success: false,
				message: 'Không có session xác thực, truy cập bị từ chối'
			});
		}

		if (!session.user || session.user.role !== 'admin') {
			return res.status(403).json({
				success: false,
				message: 'Truy cập bị từ chối. Chỉ admin mới có thể thực hiện hành động này.'
			});
		}

		// Add admin user and session to request
		req.admin = session.user;
		req.user = session.user;
		req.session = session;
		next();
	} catch (error) {
		console.error('Admin auth middleware error:', error);
		return res.status(401).json({
			success: false,
			message: 'Xác thực admin thất bại'
		});
	}
};

/**
 * Authentication middleware for seller routes
 */
const authenticateSeller = async (req, res, next) => {
	try {
		const session = await auth.api.getSession({
			headers: req.headers,
		});

		if (!session) {
			return res.status(401).json({
				success: false,
				message: 'Không có session xác thực, truy cập bị từ chối'
			});
		}

		if (!session.user || (session.user.role !== 'seller' && session.user.role !== 'admin')) {
			return res.status(403).json({
				success: false,
				message: 'Truy cập bị từ chối. Chỉ seller hoặc admin mới có thể thực hiện hành động này.'
			});
		}

		// Add seller user and session to request
		req.seller = session.user;
		req.user = session.user;
		req.session = session;
		next();
	} catch (error) {
		console.error('Seller auth middleware error:', error);
		return res.status(401).json({
			success: false,
			message: 'Xác thực seller thất bại'
		});
	}
};

/**
 * Identifies the visitor when there is a session and lets everyone else through.
 * Sets `req.viewer` to `{ id, email, emailVerified, role }`, or null for an anonymous
 * request or a session that cannot be read. It never answers 401: a public route that
 * serves more to a signed-in viewer decides for itself what null means, and a failing
 * session lookup must degrade to "anonymous", not to an open door.
 */
const authenticateOptional = async (req, res, next) => {
	req.viewer = null;
	try {
		const session = await auth.api.getSession({ headers: req.headers });
		if (session?.user) {
			const { id, email, emailVerified, role } = session.user;
			req.viewer = { id, email, emailVerified: emailVerified === true, role };
		}
	} catch (error) {
		console.error('Optional auth middleware error:', error);
	}
	next();
};

module.exports = {
	authenticateOptional,
	authenticateUser,
	authenticateAdmin,
	authenticateSeller
};
