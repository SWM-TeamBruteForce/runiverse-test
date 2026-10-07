import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 이 프록시가 있어야 App.jsx가 WS를 붙일 수 있다.
//
// 서버는 핸드셰이크에서 `Authorization: Bearer ...`를 읽는다
// (JwtHandshakeInterceptor가 SecurityContextHolder를 본다 — 쿼리 파라미터 토큰 경로가 없다).
// 그런데 브라우저 WebSocket 생성자는 헤더를 못 붙인다. 그래서 개발 프록시가
// `?token=`을 받아 업그레이드 요청의 헤더로 옮긴다 — **개발 편의용이고 서버 계약은 그대로다.**
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/v1": {
        target: "http://localhost:8080",
        // ⚠️ true로 두면 Host만 바뀌고 Origin은 브라우저 값(http://localhost:5173)이 그대로 간다.
        // 서버 WebSocketConfig가 cors.allowed-origins로 핸드셰이크 Origin을 검사하므로
        // .env의 CORS_ALLOWED_ORIGINS에 http://localhost:5173이 들어 있어야 한다. 없으면 403이다
        changeOrigin: true,
        ws: true,
        configure(proxy) {
          proxy.on("proxyReqWs", (proxyReq, req) => {
            const token = new URL(req.url, "http://localhost").searchParams.get("token");
            if (token) proxyReq.setHeader("Authorization", `Bearer ${token}`);
            // 토큰이 프록시 로그에 남지 않게 URL에서는 떼고 올린다
            proxyReq.path = proxyReq.path.replace(/([?&])token=[^&]*/, "$1");
          });
        },
      },
    },
  },
});
