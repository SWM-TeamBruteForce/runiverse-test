import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // 백엔드 context-path가 /api/v1이라 /api만 넘기면 된다.
      // 같은 출처가 되어 CORS 프리플라이트 자체가 사라진다
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        // 나중에 /api/v1/ws/running을 붙일 때 필요하다
        ws: true,
      },
    },
  },
})
