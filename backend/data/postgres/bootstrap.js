/**
 * What the first-run seed (`init-database.js`) asks of the store beyond the
 * business tables: the database's name, whether login users exist and whether one
 * of them is an admin. The login rows belong to the auth library; they are only
 * probed here, never written.
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

/** True when at least one login user has the admin role. */
async function hasAdmin() {
	return (await prisma.user.findFirst({ where: { role: 'admin' }, select: { id: true } })) !== null;
}

/**
 * True when at least one storefront exists. The storefronts migration inserts the
 * default one, so a migrated database always has it; a false here means the
 * migration did not run or the table was emptied by hand, and products cannot
 * be created until a storefront is put back.
 */
async function hasStorefront() {
	return (await prisma.storefront.findFirst({ select: { id: true } })) !== null;
}

module.exports = { databaseName, hasLoginUsers, hasAdmin, hasStorefront };
