import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { 'foliate-js': fileURLToPath(new URL('./vendor/foliate-js', import.meta.url)) } },
  build: { sourcemap: false },
  server: { host: '127.0.0.1', strictPort: true },
  preview: { host: '127.0.0.1', strictPort: true },
});
