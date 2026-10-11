import { describe, it, expect } from 'vitest';

// The package is consumed through its built output, so this runs against it:
// the global Vietnamese error map is a load-bearing side effect of the entry
// module and must survive bundling.
describe('built ESM entry', () => {
	it('answers in Vietnamese through the global error map', async () => {
		const built = await import('../dist/index.js');
		expect(built.z.string().min(3).safeParse('ab').error.issues[0].message).toBe('Phải có ít nhất 3 ký tự');
		expect(built.studentId.safeParse('27123456').error.issues[0].message).toBe(built.STUDENT_ID_HINT);
		expect(built.studentId.safeParse('26123456').success).toBe(true);
	});

	it('answers in Vietnamese when only a schema is imported from it', async () => {
		const { newPassword } = await import('../dist/index.js');
		expect(newPassword.safeParse(5).error.issues[0].message).toBe('Mật khẩu là bắt buộc');
		expect(newPassword.safeParse('abc').error.issues.map((i) => i.message)).toContain('Mật khẩu phải có từ 8-128 ký tự');
	});

	it('exports the phrase an admin types to confirm a restore', async () => {
		const { RESTORE_CONFIRMATION } = await import('../dist/index.js');
		const required = (await import('node:module')).createRequire(import.meta.url)('../dist/index.cjs');
		expect(RESTORE_CONFIRMATION).toBe('KHOI PHUC');
		expect(required.RESTORE_CONFIRMATION).toBe(RESTORE_CONFIRMATION);
	});

	it('exports the pagination helpers from the ESM and CJS builds', async () => {
		const esm = await import('../dist/index.js');
		const cjs = (await import('node:module')).createRequire(import.meta.url)('../dist/index.cjs');
		for (const built of [esm, cjs]) {
			expect(built.MAX_PAGE_LIMIT).toBe(100);
			expect(built.paginationQuery.parse({ page: '-5', limit: '9999' })).toEqual({ page: 1, limit: 100 });
			expect(built.toSkipTake(2, 10)).toEqual({ skip: 10, take: 10 });
			expect(built.buildPaginationMeta(0, { page: 1, limit: 10 }).totalPages).toBe(0);
		}
	});

	it('maps an ObjectId to the same UUIDv7 from the ESM and CJS builds', async () => {
		const esm = await import('../dist/index.js');
		const cjs = (await import('node:module')).createRequire(import.meta.url)('../dist/index.cjs');
		const oid = '507f1f77bcf86cd799439011';
		expect(esm.objectIdToUuidV7(oid)).toBe('013a7092-e8d8-7bcf-a1b3-5e650e404400');
		expect(cjs.objectIdToUuidV7(oid)).toBe(esm.objectIdToUuidV7(oid));
		expect(cjs.uuidV7ToObjectId(cjs.objectIdToUuidV7(oid))).toBe(oid);
		expect(cjs.isRecordId(oid)).toBe(true);
		expect(cjs.isUuid(oid)).toBe(false);
	});
});
