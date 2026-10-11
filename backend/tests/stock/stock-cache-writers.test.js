/**
 * `Product.stockQuantity` is a cache of the stock ledger. Outside the ledger's
 * own storage module only the creation of a product (which records an applied
 * `opening` movement in the same transaction) may set it, so every other change
 * leaves a movement to trace and re-derive it from.
 *
 * This reads the backend sources and fails when a file outside that list writes
 * the field in any storage implementation, or when an allowed file gains an
 * extra write.
 */
const fs = require('fs');
const path = require('path');

const backendRoot = path.resolve(__dirname, '..', '..');

const FAILURE_HINT = 'Only data/*/stock-ledger.js may write Product.stockQuantity; record a StockMovement instead';

// Ledger storage: one file per implementation under data/<implementation>/.
const LEDGER_STORAGE = /^data\/[^/]+\/stock-ledger\.js$/;

// Everything else that legitimately sets the field: the number of lines that
// write it, and why. A new write in one of these files changes the count.
const PRODUCT_CREATION_WRITERS = new Map([
	['models/Product.js', { writes: 1, why: 'schema definition of the field' }],
	['routes/admin/products.js', { writes: 1, why: 'create product: opening balance, recorded as an applied opening movement' }],
	['routes/admin/database.js', { writes: 1, why: 'database import: field whitelist of imported products, each with its opening movement' }],
	['init-database.js', { writes: 2, why: 'first-run seed products' }],
	// A restore inserts whole product rows with the cache the file holds. The field is never
	// named there (rows are cast as a unit), hence zero lines; the entry keeps a literal write
	// from slipping in. It reproduces a ledger-consistent snapshot: the route compares every
	// cache with the restored ledger (reconcile) inside the same transaction and rolls back on a mismatch.
	// The backup file format lists the field to validate a product row of a restore file; it writes nothing.
	['data/snapshot.js', { writes: 1, why: 'restore file format: field check of a product row, no write' }],
	['data/mongo/data-snapshot.js', { writes: 0, why: 'restore: whole product rows, cache verified against the restored ledger before commit' }]
]);

// Top-level backend directories that hold no application code. node_modules is
// skipped at any depth.
const SKIPPED_TOP_LEVEL = new Set(['tests', 'prisma', 'generated', 'uploads']);

const FIELD = 'stockQuantity';
const WRITE_PATTERNS = [
	// Object key: create / $set / $inc / update documents. The lookbehind skips the
	// else-branch of a ternary (`cond ? stockQuantity : 0`).
	new RegExp(`(?<!\\?\\s*)\\b${FIELD}['"]?\\s*:`),
	// Assignment to the property, plain or compound.
	new RegExp(`\\.${FIELD}\\s*(?:[+\\-*/%]|\\*\\*|\\|\\||&&|\\?\\?)?=(?!=)`),
	// Mongoose document setter.
	new RegExp(`\\.set\\(\\s*['"]${FIELD}['"]`),
	// The bare name as a string, as in a field whitelist used for writes; a
	// projection (`.select('stockQuantity')`) is a read.
	new RegExp(`(?<!\\.select\\(\\s*)['"]${FIELD}['"]`)
];

// Blank out comments but keep every newline so line numbers stay true.
function withoutComments(source) {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
		.split('\n')
		.map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
		.join('\n');
}

// `{ stockQuantity }` / `{ a, stockQuantity, b }` is a write unless the object is
// a destructuring pattern, i.e. its closing brace is followed by `=`.
function shorthandWriteLines(code) {
	const lines = new Set();
	const shorthand = new RegExp(`[{,]\\s*${FIELD}\\s*(?=[,}])`, 'g');
	for (const match of code.matchAll(shorthand)) {
		const start = match.index + match[0].indexOf(FIELD);
		let depth = 1;
		let end = start;
		while (end < code.length && depth > 0) {
			end += 1;
			if (code[end] === '{') depth += 1;
			if (code[end] === '}') depth -= 1;
		}
		const after = code.slice(end + 1).match(/^\s*(=+|=>)/);
		const destructuring = after !== null && after[1] === '=';
		if (!destructuring) lines.add(code.slice(0, start).split('\n').length);
	}
	return lines;
}

/** Line numbers (1-based) that write the stock cache. */
function writeLines(source) {
	const code = withoutComments(source);
	const lines = shorthandWriteLines(code);
	code.split('\n').forEach((line, index) => {
		if (WRITE_PATTERNS.some((pattern) => pattern.test(line))) lines.add(index + 1);
	});
	return [...lines].sort((a, b) => a - b);
}

function backendSourceFiles(dir = backendRoot) {
	const found = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			const skipped = entry.name === 'node_modules' || (dir === backendRoot && SKIPPED_TOP_LEVEL.has(entry.name));
			if (!skipped) found.push(...backendSourceFiles(path.join(dir, entry.name)));
		} else if (/\.(?:js|cjs|mjs)$/.test(entry.name)) {
			found.push(path.join(dir, entry.name));
		}
	}
	return found;
}

const relative = (file) => path.relative(backendRoot, file).split(path.sep).join('/');
const read = (file) => fs.readFileSync(path.join(backendRoot, file), 'utf8');

describe('stockQuantity writers', () => {
	it('recognises the ways the field is written and ignores reads and comments', () => {
		const writes = [
			'Product.updateOne({ _id }, { $inc: { stockQuantity: 1 } })',
			"Product.updateOne({ _id }, { $set: { 'stockQuantity': 0 } })",
			'Product.updateOne({ _id }, { $set: { stockQuantity } })',
			'Product.updateOne({ _id }, { $set: { name, stockQuantity, price } })',
			'Product.updateOne({ _id }, {\n\t$set: {\n\t\tname,\n\t\tstockQuantity\n\t}\n})',
			"product.set('stockQuantity', 3);",
			"const FIELDS = ['name', 'stockQuantity'];",
			'product.stockQuantity -= item.quantity;',
			'product.stockQuantity = 5;',
			'const x = { a, stockQuantity: n ? 1 : 2 };'
		];
		for (const source of writes) expect(writeLines(source), source).not.toEqual([]);

		const notWrites = [
			"Product.find().select('stockQuantity')",
			"Product.find().select( 'stockQuantity' )",
			'if (product.stockQuantity === 0) return;',
			"{ $group: { totalStock: { $sum: '$stockQuantity' } } }",
			'const { name, stockQuantity } = req.body;',
			'const {\n\tname,\n\tstockQuantity\n} = req.body;',
			'const opening = stockQuantity !== undefined ? stockQuantity : 0;',
			'// stockQuantity: 5 would be a write\nconst a = 1;',
			'/**\n * stockQuantity: the cache\n */\nconst a = 1;'
		];
		for (const source of notWrites) expect(writeLines(source), source).toEqual([]);

		expect(writeLines('const a = 1;\n/* x\n */\nProduct.updateOne({}, { $set: { stockQuantity: 1 } });')).toEqual([4]);
	});

	it('finds the real write in the ledger storage, so the scan is not vacuous', () => {
		const ledger = backendSourceFiles().map(relative).filter((file) => LEDGER_STORAGE.test(file));
		expect(ledger.length).toBeGreaterThan(0);
		for (const file of ledger) {
			expect(writeLines(read(file)), file).not.toEqual([]);
		}
	});

	it('writes the field in each allowed file exactly as often as listed', () => {
		for (const [file, { writes }] of PRODUCT_CREATION_WRITERS) {
			expect(fs.existsSync(path.join(backendRoot, file)), file).toBe(true);
			expect(writeLines(read(file)), `${file}: ${FAILURE_HINT}`).toHaveLength(writes);
		}
	});

	it('is written by no file outside the ledger storage and the product-creation paths', () => {
		const offenders = backendSourceFiles()
			.map(relative)
			.filter((file) => !LEDGER_STORAGE.test(file) && !PRODUCT_CREATION_WRITERS.has(file))
			.map((file) => ({ file, lines: writeLines(read(file)) }))
			.filter(({ lines }) => lines.length > 0)
			.map(({ file, lines }) => `${file}:${lines.join(',')}`);
		expect(offenders, FAILURE_HINT).toEqual([]);
	});
});
