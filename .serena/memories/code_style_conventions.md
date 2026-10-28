# Code style & conventions — SAB-Store

Luật cứng ở `AGENTS.md`. Đây là quy ước quan sát được trong code (kiểm lại bằng serena nếu nghi ngờ).

- Thụt lề bằng **tab** (backend + frontend).
- Backend CommonJS (`require`/`module.exports`); frontend ESM (Vite + React, component hàm + hooks, Context API).
- Tên file: kebab-case (`utils/query-guard.js`, `data/postgres/product-variants.js`); theo lân cận khi thêm file.
- Comment giải thích VÌ SAO + invariant (xem docblock `services/stock.js`, `utils/query-guard.js`), không diễn giải code.
- Query string không tin được → qua helper trong `backend/utils/query-guard.js` trước khi vào filter Prisma
  (chặn `{ $ne: null }` kiểu operator injection).
- Lỗi: throw tường minh; mã lỗi ở `backend/constants/errorCodes.js`, dựng response qua `utils/errorResponse.js`.
- Test backend: `backend/tests/<chủ-đề>/*.test.js`, helper chung ở `tests/helpers/` (`app.js`, `factories.js`).
- ASCII trong source; không emoji.
