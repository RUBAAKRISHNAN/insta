import { defineConfig, loadEnv } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { resolveApiBaseUrl } from './src/api-base-url';

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), 'VITE_');
  resolveApiBaseUrl(mode === 'production', environment.VITE_API_URL);

  return { plugins: [react(), tailwindcss()] };
});
