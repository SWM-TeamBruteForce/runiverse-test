import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 이 키가 '/api'보다 먼저 와야 한다 — 먼저 매칭되는 쪽이 이긴다
      '/api/v1/ws': {
        target: 'ws://localhost:8080',
        ws: true,
        configure: (proxy) => {
          // 브라우저 WebSocket은 헤더를 못 붙인다 — 쿼리로 받은 토큰을 여기서 헤더로 바꾼다
          proxy.on('proxyReqWs', (proxyReq, req) => {
            const token = new URL(req.url, 'http://localhost').searchParams.get('token')
            if (token) proxyReq.setHeader('Authorization', `Bearer ${token}`)
          })
        },
      },
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
})