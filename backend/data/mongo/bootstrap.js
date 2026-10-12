/**
 * What the first-run seed (`init-database.js`) asks of the store beyond the
 * business tables: the database's name, whether login users exist and whether one
 * of them is an admin. The login rows themselves belong to the auth library and
 * are only probed here, never read or written.
 */
const mongoose = require('mongoose');
const User = require('../../models/User');

/** The name the connected database announces; the seed guard's opt-in must match it. */
function databaseName() {
	return mongoose.connection.name;
}

/** True when at least one login user exists. */
async function hasLoginUsers() {
	return Boolean(await User.exists({}));
}

/** True when at least one login user has the admin role. */
async function hasAdmin() {
	return Boolean(await User.exists({ role: 'admin' }));
}

module.exports = { databaseName, hasLoginUsers, hasAdmin };
