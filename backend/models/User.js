const mongoose = require('mongoose');

// Better-auth User schema
const userSchema = new mongoose.Schema({
	// Remove id field - let better-auth handle it automatically
	email: {
		type: String,
		required: true,
		unique: true,
		lowercase: true,
		trim: true
	},
	username: {
		type: String,
		required: true,
		unique: true,
		trim: true
	},
	displayUsername: {
		type: String,
		required: false,
		trim: true
	},
	name: {
		type: String,
		required: true,
		trim: true
	},
	image: {
		type: String,
		default: null
	},
	role: {
		type: String,
		enum: ['admin', 'seller', 'user', 'customer'],
		default: 'customer'
	},
	createdAt: {
		type: Date,
		default: Date.now
	},
	updatedAt: {
		type: Date,
		default: Date.now
	}
}, {
	timestamps: true,
	collection: 'user' // Better-auth expects 'user' collection name
});

// Indexes for performance
// Note: email and username already have unique indexes from schema definition  
userSchema.index({ role: 1 });

// Pre-save middleware to update 'updatedAt'
userSchema.pre('save', function (next) {
	this.updatedAt = new Date();
	next();
});

module.exports = mongoose.model('User', userSchema);
