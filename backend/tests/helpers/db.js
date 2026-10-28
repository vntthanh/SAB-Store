/**
 * Independent inspection and fixture helpers for the store database; the
 * implementation is db-postgres.js.
 *
 * Tests assert through these instead of through the repositories under test, so
 * the check does not share code with what it checks. The interface is in domain
 * terms: ids go in and come out as strings, results are plain objects shaped
 * like the API JSON, and filters are field -> value, where an array means "any
 * of". Nothing here may call a repository or a service for its checks; it reads
 * and writes the database directly.
 *
 * Ordering: "oldest first" means createdAt with the id as a stable tie-break,
 * not insertion order.
 *
 * Fault seams (`failNext*`, `failProductCatalogReads`) return a handle. A test
 * that arms one must assert `fired()`, or a change in how production writes
 * would make its rollback check pass without exercising anything. Armed faults
 * are undone by `remove()` or `vi.restoreAllMocks()` (afterEach).
 *
 * Other seams:
 * - `withTransaction` and `txOptions` hand a service the transaction handle in
 *   the option the repository layer defines.
 * - `isRowId` states that the pricing service returns an id in the store's
 *   native representation: true for a lowercase uuid string, false for
 *   anything else (an uppercase uuid, a 24-hex string or a number).
 * - `settingsDefaults` is not data access: it hands tests the default notice
 *   and contact values and the notice length limit, which production code
 *   keeps in constants/settings.js.
 * - The `user` and `account` kinds of `countRows`, `insertRawUser`,
 *   `findAuthRows` and `countAuthRows` reach the login tables, which belong to
 *   the auth library and not to the store. They let a test prove an import, a
 *   restore or a seed never creates or leaves a login row, and an export never
 *   carries one.
 * - `findOrderRaw` returns an order with the store's native ids kept.
 * - `databaseName` is the name the database announces for the seed guard's
 *   opt-in (`INIT_EMPTY_DATABASE`).
 */
module.exports = require('./db-postgres');
