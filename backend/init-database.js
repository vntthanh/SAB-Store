const { connectDB } = require('./lib/database');
const { auth } = require('./lib/auth');
const Product = require('./models/Product');
const User = require('./models/User');
const Account = require('./models/Account');
const Settings = require('./models/Settings');
const crypto = require('crypto');
require('dotenv').config();

const SETTINGS_KEY = 'payment_config';

async function initDatabase() {
	try {
		// Connect to MongoDB using Mongoose
		await connectDB();
		console.log('✅ Connected to MongoDB via Mongoose');

		// Admin credentials from environment
		const adminEmail = process.env.ADMIN_EMAIL;
		const adminUsername = process.env.ADMIN_USERNAME;
		const adminPassword = process.env.ADMIN_PASSWORD;

		// No fallbacks: a deploy with a missing .env used to silently create an
		// admin with a well-known password.
		if (!adminEmail || !adminUsername || !adminPassword) {
			throw new Error('ADMIN_EMAIL, ADMIN_USERNAME and ADMIN_PASSWORD are all required');
		}

		// Check if admin user already exists in database
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

		// log all accounts and users in the database
		const allUsers = await User.find();
		const allAccounts = await Account.find();

		// Initialize payment settings
		const existingSettings = await Settings.findOne({ key: SETTINGS_KEY });

		if (!existingSettings) {
			const bankNameId = process.env.BANK_NAME_ID || 'MB';
			const bankAccountId = process.env.BANK_ACCOUNT_ID || '0123456789';
			const prefixMessage = process.env.PREFIX_MESSAGE || 'SAB';

			await Settings.create({
				key: SETTINGS_KEY,
				bankNameId,
				bankAccountId,
				prefixMessage,
				updatedBy: 'system'
			});

			console.log('✅ Initialized payment settings');
		} else {
			console.log('⚠️  Payment settings already exist');
		}

		// Create sample products using Mongoose
		const existingProducts = await Product.countDocuments();

		if (existingProducts === 0) {
			const sampleProducts = [
				{
					name: "Áo thun SAB",
					price: 150000,
					image: "/fallback-product.png",
					description: "Áo thun chất lượng cao với logo SAB",
					status: "active",
					category: "Đồ mặc",
					stockQuantity: 50,
					available: true
				},
				{
					name: "Mũ SAB",
					price: 100000,
					image: "/fallback-product.png",
					description: "Mũ snapback phong cách với logo SAB",
					status: "active",
					category: "Phụ kiện",
					stockQuantity: 30,
					available: true
				}
			];

			await Product.insertMany(sampleProducts);
			console.log('✅ Created sample products');
		}

		console.log('✅ Database initialization completed successfully!');
		process.exit(0);

	} catch (error) {
		console.error('❌ Error initializing database:', error);
		process.exit(1);
	}
}

initDatabase();
