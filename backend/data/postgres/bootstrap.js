/**
 * What the first-run seed (`init-database.js`) asks of the store beyond the
 * business tables: the database's name and whether login users exist. The login
 * rows belong to the auth library; they are only probed here, never written.
 */
const { prisma } = require('../../lib/prisma');

/** The name the connected database announces; the seed guard's opt-in must match it. */
async function databaseName() {
	const [row] = await prisma.$queryRaw`SELECT current_database() AS name`;
	return row.name;
}

/** True when at least one login user exists. */
async function hasLoginUsers() {
	return (await prisma.user.findFirst({ select: { id: true } })) !== null;
}

/**
 * True when a login user already has this email or username. The auth library
 * stores both trimmed and lowercased, so a mixed-case ADMIN_EMAIL must be folded
 * the same way here (Mongoose's `lowercase` setter does it on the Mongo side);
 * otherwise the next boot misses the seeded admin and createUser fails on it.
 */
async function loginUserExists({ email, username }) {
	const fold = (value) => value.trim().toLowerCase();
	const where = { OR: [{ email: fold(email) }, { username: fold(username) }] };
	return (await prisma.user.findFirst({ where, select: { id: true } })) !== null;
}

module.exports = { databaseName, hasLoginUsers, loginUserExists };
