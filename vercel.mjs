import { createVercelConfig } from './vercel-config.mjs';

export const config = createVercelConfig({
  renderApiOrigin: process.env.RENDER_API_ORIGIN,
  vercelDeploymentHosts: [
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_URL,
  ].filter(Boolean),
});
