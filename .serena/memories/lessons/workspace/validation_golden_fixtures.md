# Request validation is pinned by golden fixtures

- `packages/shared/tests/fixtures/validation-golden.json` holds the reference status + `errors[]` per case for every validated route; `backend/tests/validation/golden-replay.test.js` replays them through the real app, frontend `schema-rules.test.js` checks client messages against the same cases.
- Accepted differences live in per-case `intentional` blocks with a reason. Capture refuses to overwrite a fixture that has them.
- Replay uses one listening server: supertest on a bare app opens a server per request and the churn ends requests with ECONNRESET under the full parallel suite.

**Why:** 05/10/2026 the migration off express-validator was proven case by case this way; the per-request server caused repeated flaky hook failures that day.
**How to apply:** changing a route's validation = update `golden-cases.js` and the fixture deliberately (or add an `intentional` block); never re-capture blindly.
