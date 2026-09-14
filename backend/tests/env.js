/**
 * Environment defaults for tests.
 *
 * Loaded via jest `setupFiles`, which runs before any test module is imported.
 * That ordering matters: lib/auth.js validates JWT_SECRET and MONGODB_URI at
 * require time, so setting these inside a beforeAll hook would be too late.
 *
 * MONGODB_URI is a placeholder that satisfies the import-time check; setup.js
 * replaces it with the real in-memory server URI before any query runs.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-value-at-least-32-chars-long';
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
process.env.BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
