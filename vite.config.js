import { resolve } from 'node:path'

export default {
  root: 'web',
  build: {
    // multi-page: emit both the synthwave demo and the real-roads page
    rolldownOptions: {
      input: {
        main:  resolve(import.meta.dirname, 'web/index.html'),
        drive: resolve(import.meta.dirname, 'web/drive.html')
      }
    }
  },
  server: {
    host: '127.0.0.1',
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    strictPort: !!process.env.PORT
  }
}
