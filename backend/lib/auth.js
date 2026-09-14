const { betterAuth } = require("better-auth");
const { MongoClient } = require("mongodb");
const { mongodbAdapter } = require("better-auth/adapters/mongodb");
const { admin, openAPI } = require("better-auth/plugins");
const { username } = require("better-auth/plugins");
const { jwt } = require("better-auth/plugins");
const { customSession } = require("better-auth/plugins");
const { createAuthMiddleware, APIError } = require("better-auth/api");
const { COMMON_PASSWORDS } = require("../utils/passwordValidator");

// Get MongoDB URI from environment variables
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
	throw new Error('MONGODB_URI environment variable is required');
}

// Session signing secret. Better-auth only hard-fails on its own DEFAULT_SECRET,
// so a committed placeholder would boot silently with a publicly known key.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
	throw new Error('JWT_SECRET environment variable is required and must be at least 32 characters');
}
if (/change-this|your-super-secret|secret-key-here|changeme/i.test(JWT_SECRET)) {
	throw new Error('JWT_SECRET is still a placeholder value; set a real secret');
}

// Create MongoDB connection
const client = new MongoClient(MONGODB_URI);
const db = client.db();

// Origins allowed to hold a session cookie against this API. CORS_ORIGIN is
// the single source of truth (Phase 03 derives it from PUBLIC_URL at the
// compose layer) — no domain is ever hardcoded here, so this stays correct
// regardless of which domain currently fronts production. server.js reuses
// this same function for CORS and CSP so there is exactly one list.
function getAllowedOrigins() {
	return [
		...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(origin => origin.trim()).filter(Boolean) : []),
		...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000', 'http://127.0.0.1:3000'] : []),
	];
}

const auth = betterAuth({
	database: mongodbAdapter(db),
	baseURL: process.env.BASE_URL || "http://localhost:5000",
	secret: JWT_SECRET,
	trustedOrigins: getAllowedOrigins(),
	emailAndPassword: {
		enabled: true,
		// Raised from the previous 6: at 6, "123456" — the single most common
		// leaked password — satisfied the length check on its own, ahead of
		// even reaching the common-password blocklist below. Existing users'
		// stored password hashes are untouched; this only gates new/changed
		// passwords (sign-up, reset-password, change-password).
		minPasswordLength: 8,
		maxPasswordLength: 128,
		requireEmailVerification: false,
		sendEmailVerificationOnSignUp: false,
	},
	// Registration bypasses the express-validator blocklist in
	// utils/passwordValidator.js entirely (better-auth's own HTTP handler is
	// mounted ahead of any route-level validation middleware), so "123456"
	// being the first blocklist entry never actually blocked sign-up. Reuse
	// the same list here so registration gets the same defense.
	hooks: {
		before: createAuthMiddleware(async (ctx) => {
			if (ctx.path !== "/sign-up/email") {
				return;
			}
			const password = ctx.body?.password;
			if (typeof password === "string" && COMMON_PASSWORDS.includes(password.toLowerCase())) {
				throw new APIError("BAD_REQUEST", {
					message: "Mật khẩu này quá phổ biến và không an toàn. Vui lòng chọn mật khẩu khác",
				});
			}
		}),
	},
	plugins: [
		// Exposes the full API schema at /api/auth/reference; no reason to ship
		// that surface to production.
		...(process.env.NODE_ENV !== 'production' ? [openAPI()] : []),
		username({
			minUsernameLength: 3,
			maxUsernameLength: 30,
		}),
		admin({
			defaultRole: "user",
			adminRoles: ["admin"],
			adminUserIds: [],
		}),
		customSession(async ({ user, session }) => {
			return {
				user: {
					...user,
					role: user.role, // Ensure role is included in session
				},
				session
			};
		}),
		jwt({
			jwt: {
				issuer: process.env.BASE_URL || "http://localhost:5000",
				audience: process.env.BASE_URL || "http://localhost:5000",
				expirationTime: "15m",
				definePayload: ({ user }) => {
					return {
						id: user.id,
						email: user.email,
						username: user.username,
						role: user.role,
						name: user.name,
					};
				},
			},
		}),
	],
	session: {
		expiresIn: 60 * 60 * 24 * 7, // 7 days
		updateAge: 60 * 60 * 24, // 1 day
	},
	user: {
		additionalFields: {
			username: {
				type: "string",
				required: true,
			},
			displayUsername: {
				type: "string",
				required: false,
			},
			role: {
				type: "string",
				defaultValue: "user",
				required: false,
				// Must never be settable from the request body. Without this, `role`
				// joins the public /sign-up/email and /update-user schemas and any
				// visitor can register straight into the admin role.
				input: false,
			},
		},
		modelName: "user",
	},
});

// Exposed so a caller that owns process shutdown (see tests/setup.js /
// jest.config.js forceExit) can close this connection explicitly — better-auth
// never exposes it, so nothing else closes this handle in tests, and jest
// hangs after the last test without --forceExit.
module.exports = { auth, getAllowedOrigins, client };
