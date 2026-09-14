const { betterAuth } = require("better-auth");
const { MongoClient } = require("mongodb");
const { mongodbAdapter } = require("better-auth/adapters/mongodb");
const { admin, openAPI } = require("better-auth/plugins");
const { username } = require("better-auth/plugins");
const { jwt } = require("better-auth/plugins");
const { customSession } = require("better-auth/plugins");

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

const auth = betterAuth({
	database: mongodbAdapter(db),
	baseURL: process.env.BASE_URL || "http://localhost:5000",
	secret: JWT_SECRET,
	trustedOrigins: [
		...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(origin => origin.trim()) : []),
		'https://store.sab.edu.vn',
		'https://api.store.sab.edu.vn',
		'http://localhost:3000',
		'http://127.0.0.1:3000'
	],
	emailAndPassword: {
		enabled: true,
		minPasswordLength: 6,
		maxPasswordLength: 128,
		requireEmailVerification: false,
		sendEmailVerificationOnSignUp: false,
	},
	plugins: [
		openAPI(),
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

module.exports = { auth };
