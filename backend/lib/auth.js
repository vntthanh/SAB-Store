const { betterAuth } = require("better-auth");
const { admin, openAPI, username, jwt, customSession, emailOTP, oneTap } = require("better-auth/plugins");
const { createAuthMiddleware, APIError } = require("better-auth/api");
const { COMMON_PASSWORDS } = require("../utils/passwordValidator");
const { buildTrustedProxies, toCidrs } = require("./trusted-proxies");
const { isUuid } = require("@sab/shared");
const { backendName } = require("../data/backend-name");
const { OTP_EXPIRES_IN_SECONDS, CUSTOMER_ROLE, guardAuthRequest, sendSignInCode, beforeUserCreate } = require("./auth-guards");

const POSTGRES = backendName === 'postgres';

// Session signing secret. Better-auth only hard-fails on its own DEFAULT_SECRET,
// so a committed placeholder would boot silently with a publicly known key.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
	throw new Error('JWT_SECRET environment variable is required and must be at least 32 characters');
}
if (/change-this|your-super-secret|secret-key-here|changeme/i.test(JWT_SECRET)) {
	throw new Error('JWT_SECRET is still a placeholder value; set a real secret');
}

// The login tables live in whichever store the data layer runs on. Each branch
// loads only its own driver, so a process never opens the store it does not use.
// Better Auth hands out ObjectId-shaped ids on mongo; on postgres the id columns
// are native uuid, which refuses anything else (22P02), so ids are minted here.
function createStorage() {
	if (POSTGRES) {
		const { prismaAdapter } = require("better-auth/adapters/prisma");
		const { v7: uuidv7 } = require("uuid");
		const { prisma, closeDb } = require("./prisma");
		return {
			database: prismaAdapter(prisma, { provider: "postgresql" }),
			generateId: () => uuidv7(),
			close: closeDb,
		};
	}
	const MONGODB_URI = process.env.MONGODB_URI;
	if (!MONGODB_URI) {
		throw new Error('MONGODB_URI environment variable is required');
	}
	const { MongoClient } = require("mongodb");
	const { mongodbAdapter } = require("better-auth/adapters/mongodb");
	const client = new MongoClient(MONGODB_URI);
	return {
		database: mongodbAdapter(client.db()),
		close: () => client.close(),
	};
}

const storage = createStorage();

// Origins allowed to hold a session cookie against this API. CORS_ORIGIN is
// the single source of truth (the compose layer derives it from PUBLIC_URL)
// — no domain is ever hardcoded here, so this stays correct
// regardless of which domain currently fronts production. server.js reuses
// this same function for CORS and CSP so there is exactly one list.
function getAllowedOrigins() {
	return [
		...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(origin => origin.trim()).filter(Boolean) : []),
		...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000', 'http://127.0.0.1:3000'] : []),
	];
}

// Better Auth enforces this on its own sign-in/change/reset routes but not on
// /admin/create-user, which the hook below covers.
const MIN_PASSWORD_LENGTH = 8;

// Endpoints that set a password, and the body field carrying it.
const PASSWORD_FIELD_BY_PATH = {
	"/admin/create-user": "password",
	"/admin/set-user-password": "newPassword",
	"/change-password": "newPassword",
	"/reset-password": "newPassword",
};

// Every email-code endpoint except the two sign-in ones. `reset-password` would let
// anyone who can read a mailbox set a password, but the admin is the only credential
// authority; verify-email, check-verification-otp and the email-change pair have no
// caller either. `disabledPaths` answers 404 at the router, ahead of every hook, so
// closing them does not depend on hook path matching. (`createVerificationOTP` and
// `getVerificationOTP` are server-only and have no HTTP route at all.)
const DISABLED_EMAIL_OTP_PATHS = [
	"/email-otp/verify-email",
	"/email-otp/check-verification-otp",
	"/email-otp/request-password-reset",
	"/forget-password/email-otp",
	"/email-otp/reset-password",
	"/email-otp/request-email-change",
	"/email-otp/change-email",
];

// Google One Tap needs only the public client id: the plugin checks the ID token's
// signature and audience against Google's keys, with no secret and no code exchange.
// Google is deliberately NOT in `socialProviders`: a redirect provider needs a client
// secret, and registering one without it makes every redirect attempt fail. Without
// the env the button is simply not offered.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

// Better Auth's own limiter is off outside production unless enabled; the sign-in code
// limits must hold in every NODE_ENV, so it is enabled explicitly. Its built-in
// stricter defaults for /sign-in/*, /sign-up/* and /change-password (3 per 10 s per
// IP) are left alone in production, but would starve a test suite that signs in dozens
// of times from one address, so the test environment lifts only those.
// Memory storage is correct for the single backend container; a second replica would
// need a shared store, and the DB-backed cooldown below holds regardless.
const TEST_ENV_RELIEF = process.env.NODE_ENV === "test"
	? { "/sign-in/email": false, "/sign-in/username": false, "/sign-up/email": false, "/change-password": false }
	: {};

const auth = betterAuth({
	database: storage.database,
	baseURL: process.env.BASE_URL || "http://localhost:5000",
	secret: JWT_SECRET,
	trustedOrigins: getAllowedOrigins(),
	advanced: {
		...(storage.generateId && { database: { generateId: storage.generateId } }),
		// Better Auth refuses a multi-hop X-Forwarded-For unless told which hops to
		// trust (the leftmost entry is client-controlled) and would key every
		// request into one shared rate-limit bucket. With the list, the chain is
		// stripped from the right to the first untrusted hop: the client Express sees.
		ipAddress: { trustedProxies: toCidrs(buildTrustedProxies()) },
	},
	emailAndPassword: {
		enabled: true,
		// Raised from the previous 6: at 6, "123456" — the single most common
		// leaked password — satisfied the length check on its own, ahead of
		// even reaching the common-password blocklist below. Existing users'
		// stored password hashes are untouched; this only gates new/changed
		// passwords (admin create/reset, reset-password, change-password).
		minPasswordLength: MIN_PASSWORD_LENGTH,
		maxPasswordLength: 128,
		// Accounts are created only by the admin (admin.createUser, and
		// auth.api.createUser when seeding); there is no public registration.
		disableSignUp: true,
		requireEmailVerification: false,
		sendEmailVerificationOnSignUp: false,
	},
	// better-auth's own HTTP handler is mounted ahead of any route-level
	// validation middleware, so the password endpoints never reach the request
	// schemas; reuse the shared blocklist here so every route that sets a
	// password gets the same defense ("123456" is its first entry).
	hooks: {
		before: createAuthMiddleware(async (ctx) => {
			// A guard may answer on its own (the unverified-account send); that response must be returned for the endpoint not to run.
			const answered = await guardAuthRequest(ctx);
			if (answered) return answered;
			// A user id that is not a uuid reaches the native uuid column and fails there
			// (22P02) as an empty 500; Mongo answers the same request with a 404. A legacy
			// 24-hex id is refused too: the admin page only sends ids it got from list-users.
			if (POSTGRES && ctx.path.startsWith("/admin/")) {
				const ids = [ctx.body?.userId, ctx.path === "/admin/get-user" ? ctx.query?.id : undefined];
				if (ids.some((id) => id !== undefined && !isUuid(id))) {
					throw new APIError("BAD_REQUEST", { message: "Mã người dùng không hợp lệ" });
				}
			}
			const passwordField = PASSWORD_FIELD_BY_PATH[ctx.path];
			if (!passwordField) {
				return;
			}
			const password = ctx.body?.[passwordField];
			if (ctx.path === "/admin/create-user" && typeof password === "string" && password.length < MIN_PASSWORD_LENGTH) {
				throw new APIError("BAD_REQUEST", {
					message: `Mật khẩu phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự`,
				});
			}
			if (typeof password === "string" && COMMON_PASSWORDS.includes(password.toLowerCase())) {
				throw new APIError("BAD_REQUEST", {
					message: "Mật khẩu này quá phổ biến và không an toàn. Vui lòng chọn mật khẩu khác",
				});
			}
		}),
	},
	disabledPaths: DISABLED_EMAIL_OTP_PATHS,
	rateLimit: {
		enabled: true,
		storage: "memory",
		customRules: {
			"/email-otp/send-verification-otp": { window: 60, max: 3 },
			"/sign-in/email-otp": { window: 300, max: 10 },
			...TEST_ENV_RELIEF,
		},
	},
	account: {
		// Lets a Google sign-in attach to an existing local account with the same
		// email (staff who also want One Tap). The default requireLocalEmailVerified
		// (true) stays: a staff account whose email an admin has not vouched for
		// cannot be taken over through Google. Google's own email_verified claim is
		// enforced in the one-tap guard, because trusting a provider skips that check.
		accountLinking: { enabled: true, trustedProviders: ["google"] },
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
			defaultRole: CUSTOMER_ROLE,
			adminRoles: ["admin"],
			adminUserIds: [],
		}),
		emailOTP({
			otpLength: 6,
			expiresIn: OTP_EXPIRES_IN_SECONDS,
			// 5 wrong guesses burn the code (6 digits, so ~1 in 200 000 to guess).
			allowedAttempts: 5,
			// A database read must not reveal a usable code.
			storeOTP: "hashed",
			// A first sign-in by code is how a customer registers.
			disableSignUp: false,
			// Explicit: changing an email through a code is not offered (staff email is
			// set by an admin, customer email is their identity).
			changeEmail: { enabled: false },
			sendVerificationOTP: sendSignInCode,
		}),
		...(GOOGLE_CLIENT_ID ? [oneTap({ clientId: GOOGLE_CLIENT_ID })] : []),
		customSession(async ({ user, session }) => {
			return {
				user: {
					...user,
					role: user.role, // Ensure role is included in session
					email: user.email,
					emailVerified: user.emailVerified === true,
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
	databaseHooks: {
		user: { create: { before: beforeUserCreate } },
	},
	user: {
		// Explicit: /change-email stays off. Email is the sign-in identity of customers
		// and an admin-vouched credential for staff.
		changeEmail: { enabled: false },
		additionalFields: {
			// Optional at parse time: a first-time email-code or One Tap sign-in carries
			// none, and the create hook always generates it for customers.
			username: {
				type: "string",
				required: false,
			},
			displayUsername: {
				type: "string",
				required: false,
			},
			role: {
				type: "string",
				defaultValue: CUSTOMER_ROLE,
				required: false,
				// Must never be settable from a self-service request body: otherwise
				// /update-user would let any signed-in user choose their own role.
				input: false,
			},
		},
		modelName: "user",
	},
});

// Exposed so a caller that owns process shutdown (tests/setup.js) can close what
// auth opened: better-auth never exposes its connection, and an open handle keeps
// the test worker alive after the last test.
const closeAuth = storage.close;

module.exports = { auth, getAllowedOrigins, closeAuth };
