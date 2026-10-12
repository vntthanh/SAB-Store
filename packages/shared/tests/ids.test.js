import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { objectIdToUuidV7, uuidV7ToObjectId, isUuid, isRecordId } from '../src/ids.js';

// ObjectId = 4-byte big-endian seconds + 8 bytes (process random + counter).
const objectId = (seconds, tail = randomBytes(8).toString('hex')) => seconds.toString(16).padStart(8, '0') + tail;

describe('objectIdToUuidV7', () => {
	it.each([
		['507f1f77bcf86cd799439011', '013a7092-e8d8-7bcf-a1b3-5e650e404400'],
		['000000000000000000000000', '00000000-0000-7000-8000-000000000000'],
		['ffffffffffffffffffffffff', '03e7ffff-fc18-7fff-bfff-fffffffffc00'],
		['65a1b2c3d4e5f60718293a4b', '018cffa2-49b8-7d4e-97d8-1c60a4e92c00'],
	])('maps %s to the known vector %s', (oid, uuid) => {
		expect(objectIdToUuidV7(oid)).toBe(uuid);
	});

	it('puts the ObjectId seconds, as milliseconds, in the 48-bit timestamp prefix', () => {
		const seconds = Date.UTC(2026, 9, 11, 3, 21, 0) / 1000;
		const uuid = objectIdToUuidV7(objectId(seconds));
		const prefix = uuid.slice(0, 13).replace('-', '');
		expect(parseInt(prefix, 16)).toBe(seconds * 1000);
		expect(new Date(parseInt(prefix, 16)).toISOString()).toBe('2026-10-11T03:21:00.000Z');
	});

	it('sets version 7 and the RFC variant on every result', () => {
		for (let i = 0; i < 200; i++) {
			const uuid = objectIdToUuidV7(objectId(Math.floor(Math.random() * 0xffffffff)));
			expect(uuid[14]).toBe('7');
			expect('89ab').toContain(uuid[19]);
			expect(isUuid(uuid)).toBe(true);
		}
	});

	it('is deterministic and lowercases its input', () => {
		const oid = 'ABCDEF0123456789ABCDEF01';
		expect(objectIdToUuidV7(oid)).toBe(objectIdToUuidV7(oid));
		expect(objectIdToUuidV7(oid)).toBe(objectIdToUuidV7(oid.toLowerCase()));
	});

	it('round-trips through uuidV7ToObjectId, with the extremes', () => {
		const samples = ['000000000000000000000000', 'ffffffffffffffffffffffff', '0000000000000000ffffffff'.padEnd(24, '0')];
		for (let i = 0; i < 500; i++) samples.push(randomBytes(12).toString('hex'));
		for (const oid of samples) expect(uuidV7ToObjectId(objectIdToUuidV7(oid))).toBe(oid);
	});

	it('is injective over random samples, including ids that differ in one bit', () => {
		const seen = new Map();
		const record = (oid) => {
			const uuid = objectIdToUuidV7(oid);
			expect(seen.has(uuid) && seen.get(uuid) !== oid).toBe(false);
			seen.set(uuid, oid);
		};
		for (let i = 0; i < 5000; i++) {
			const oid = randomBytes(12).toString('hex');
			record(oid);
			const bit = Math.floor(Math.random() * 96);
			const flipped = BigInt(`0x${oid}`) ^ (1n << BigInt(bit));
			record(flipped.toString(16).padStart(24, '0'));
		}
		expect(seen.size).toBeGreaterThan(9000);
	});

	it('keeps order: ObjectIds that increase in time give UUIDs that sort the same way', () => {
		const base = 1_790_000_000;
		const ids = [];
		for (let s = 0; s < 40; s++) {
			// Same second: the counter (last 3 bytes) increments after a fixed random part.
			const random = randomBytes(5).toString('hex');
			for (let counter = 0; counter < 3; counter++) {
				ids.push(objectId(base + s, random + (counter * 70000).toString(16).padStart(6, '0')));
			}
		}
		const uuids = ids.map(objectIdToUuidV7);
		expect(uuids).toEqual([...uuids].sort());
		expect(ids).toEqual([...ids].sort());
	});

	it.each([
		['too short', '507f1f77bcf86cd79943901'],
		['too long', '507f1f77bcf86cd7994390112'],
		['non-hex', '507f1f77bcf86cd79943901g'],
		['a uuid', '013a7092-e8d8-7bcf-a1b3-5e650e404400'],
		['empty', ''],
		['whitespace padded', ' 507f1f77bcf86cd799439011'],
	])('throws for %s', (_label, input) => {
		expect(() => objectIdToUuidV7(input)).toThrow(TypeError);
	});

	it.each([[undefined], [null], [123], [{}], [['507f1f77bcf86cd799439011']]])('throws for the non-string %j', (input) => {
		expect(() => objectIdToUuidV7(input)).toThrow(TypeError);
	});
});

describe('uuidV7ToObjectId', () => {
	it('rejects a UUID the map cannot have produced', () => {
		// Real v7 id (milliseconds not a multiple of 1000, tail bits set).
		expect(() => uuidV7ToObjectId('019bd5a1-2b3c-7def-8123-456789abcdef')).toThrow(TypeError);
		// Not a v7.
		expect(() => uuidV7ToObjectId('550e8400-e29b-41d4-a716-446655440000')).toThrow(TypeError);
		expect(() => uuidV7ToObjectId('nope')).toThrow(TypeError);
	});
});

describe('isUuid / isRecordId', () => {
	const v7 = '019bd5a1-2b3c-7def-8123-456789abcdef';
	const v4 = '550e8400-e29b-41d4-a716-446655440000';
	const oid = '507f1f77bcf86cd799439011';

	it('isUuid takes canonical lowercase UUIDs of any version only', () => {
		expect(isUuid(v7)).toBe(true);
		expect(isUuid(v4)).toBe(true);
		expect(isUuid(v7.toUpperCase())).toBe(false);
		expect(isUuid(v7.replace(/-/g, ''))).toBe(false);
		expect(isUuid(`${v7} `)).toBe(false);
		expect(isUuid('019bd5a1-2b3c-9def-8123-456789abcdef')).toBe(false);
		expect(isUuid('019bd5a1-2b3c-7def-c123-456789abcdef')).toBe(false);
		expect(isUuid(oid)).toBe(false);
		expect(isUuid(null)).toBe(false);
	});

	it('isRecordId also takes a legacy ObjectId, for the transition', () => {
		expect(isRecordId(v7)).toBe(true);
		expect(isRecordId(oid)).toBe(true);
		expect(isRecordId(oid.toUpperCase())).toBe(true);
		expect(isRecordId(objectIdToUuidV7(oid))).toBe(true);
		for (const bad of ['', 'x', oid.slice(1), `${oid}0`, { $ne: null }, ['a'], undefined, 5]) {
			expect(isRecordId(bad)).toBe(false);
		}
	});
});
