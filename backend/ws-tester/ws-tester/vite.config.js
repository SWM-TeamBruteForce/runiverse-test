import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
const BACKEND = 'http://localhost:8080'
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: BACKEND,
        changeOrigin: true,
        ws: true,
        configure: (proxy) => {
          // 브라우저 WebSocket은 헤더를 못 붙인다 — ?token= 를 Authorization으로 옮겨준다
          proxy.on('proxyReqWs', (proxyReq, req) => {
            const token = new URL(req.url, 'http://localhost').searchParams.get('token')
            if (token) proxyReq.setHeader('Authorization', `Bearer ${token}`)
          })
        },
      },
    },
  },
})