import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const TARGET = 'http://localhost:8080';

// 브라우저는 WebSocket·EventSource에 헤더를 못 붙인다 — ?token=을 Authorization 헤더로 옮긴다.
// Origin은 지운다: 프록시 뒤라 서버가 5173을 교차 출처로 보고 CORS·WS 출처 검사에 걸린다
function moveTokenToHeader(proxyReq, req) {
  const url = new URL(req.url, 'http://local');
  const token = url.searchParams.get('token');
  if (token) {
    proxyReq.setHeader('Authorization', `Bearer ${token}`);
  }
  proxyReq.removeHeader('origin');
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: TARGET,
        changeOrigin: true,
        ws: true,
        configure: (proxy) => {
          proxy.on('proxyReq', moveTokenToHeader);
          proxy.on('proxyReqWs', moveTokenToHeader);
        },
      },
    },
  },
});
