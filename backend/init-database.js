const mongoose = require('mongoose');
const { connectDB } = require('./lib/database');
const { auth } = require('./lib/auth');
const Product = require('./models/Product');
const User = require('./models/User');
const Settings = require('./models/Settings');
require('dotenv').config();

const { SETTINGS_KEY } = Settings;

// Throws on failure instead of exiting so tests can drive it; the CLI wrapper
// below owns the process exit code.
async function initDatabase() {
	const isProduction = process.env.NODE_ENV === 'production';

	await connectDB();
	console.log('✅ Connected to MongoDB via Mongoose');

	const adminEmail = process.env.ADMIN_EMAIL;
	const adminUsername = process.env.ADMIN_USERNAME;
	const adminPassword = process.env.ADMIN_PASSWORD;

	// No fallbacks: a deploy with a missing .env used to silently create an
	// admin with a well-known password.
	if (!adminEmail || !adminUsername || !adminPassword) {
		throw new Error('ADMIN_EMAIL, ADMIN_USERNAME and ADMIN_PASSWORD are all required');
	}

	// A MONGODB_URI naming the wrong database looks exactly like a fresh
	// install. Creating an admin there would silently split production data
	// across two databases, so a first deploy must opt in by naming the database
	// it expects. A plain `true` would keep the guard off forever if the flag
	// were left behind; a name only matches the database it was meant for.
	const dbName = mongoose.connection.name;
	const optIn = process.env.INIT_EMPTY_DATABASE;
	const hasUsers = await User.exists({});
	if (isProduction && !hasUsers && optIn !== dbName) {
		throw new Error(
			`database "${dbName}" looks empty - refusing to initialise in production; ` +
			`set INIT_EMPTY_DATABASE=${dbName} for a first deploy`
		);
	}
	if (optIn && hasUsers) {
		console.warn('⚠️  INIT_EMPTY_DATABASE is set but the database already has users - remove it');
	}

	const existingUser = await User.findOne({
		$or: [{ email: adminEmail }, { username: adminUsername }]
	});

	if (existingUser) {
		console.log('⚠️ Existing admin user found');
	}
	else {

		await auth.api.createUser({
			body: {
				email: adminEmail,
				name: 'System Administrator',
				password: adminPassword,
				role: 'admin',
				data: {
					username: adminUsername,
					displayUsername: 'Admin',
				}
			},
		});
	}

	// Bank details are store configuration edited by the admin in Settings, not
	// deploy variables. Production starts without them: until the admin fills
	// them in, orders are accepted without a payment QR code (the error is only
	// logged), which beats paying customers into a placeholder account. Configure
	// Settings before opening the store. Local setups get a placeholder so
	// checkout can be exercised.
	const existingSettings = await Settings.exists({ key: SETTINGS_KEY });
	if (!existingSettings && !isProduction) {
		await Settings.create({
			key: SETTINGS_KEY,
			bankNameId: 'MB',
			bankAccountId: '0123456789',
			prefixMessage: 'SAB',
			updatedBy: 'system'
		});
		console.log('✅ Initialized placeholder payment settings');
	} else if (!existingSettings) {
		console.warn('⚠️  Payment settings not configured - set the bank account in admin Settings');
	}

	// Sample products would show up in a real storefront.
	if (!isProduction && (await Product.countDocuments()) === 0) {
		const sampleProducts = [
			{
				name: "Áo thun SAB",
				price: 150000,
				image: "/fallback-product.png",
				description: "Áo thun chất lượng cao với logo SAB",
				status: "active",
				category: "Đồ mặc",
				stockQuantity: 50,
				available: true,
				salesChannel: 'all'
			},
			{
				name: "Mũ SAB",
				price: 100000,
				image: "/fallback-product.png",
				description: "Mũ snapback phong cách với logo SAB",
				status: "active",
				category: "Phụ kiện",
				stockQuantity: 30,
				available: true,
				salesChannel: 'all'
			}
		];

		await Product.insertMany(sampleProducts);
		console.log('✅ Created sample products');
	}

	console.log('✅ Database initialization completed successfully!');
}

module.exports = { initDatabase };

if (require.main === module) {
	initDatabase()
		.then(() => process.exit(0))
		.catch((error) => {
			console.error('❌ Error initializing database:', error);
			process.exit(1);
		});
}
