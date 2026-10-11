/**
 * What the first-run seed (`init-database.js`) asks of the store beyond the
 * business tables: the database's name and whether login users exist. The login
 * rows themselves belong to the auth library and are only counted here, never
 * read or written.
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

/** True when a login user already has this email or username. */
async function loginUserExists({ email, username }) {
	return Boolean(await User.exists({ $or: [{ email }, { username }] }));
}

module.exports = { databaseName, hasLoginUsers, loginUserExists };
