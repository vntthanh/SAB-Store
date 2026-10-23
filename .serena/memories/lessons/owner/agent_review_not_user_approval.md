# Agent duyệt thay user

- Không dừng hỏi user duyệt plan, review gate, số liệu dry-run hay "làm tiếp nhé?". Chạy ≥2–3 agent review/red-team (sonnet), tự thẩm định phát hiện rồi làm tiếp.
- Vẫn hỏi khi chạm quyết định sản phẩm thật (hành vi/nghiệp vụ code không trả lời được).
- Cổng deploy user đặt (cửa sổ yên tĩnh, downtime — `mem:lessons/deploy/coolify_compose_constraints`) vẫn áp dụng: tự kiểm, không hỏi.

**Why:** 05/10/2026 owner: "Bạn cho nhiều agent duyệt, tôi không cần duyệt" — muốn việc chạy liên tục; agent review là cổng chất lượng.
