import assert from 'node:assert/strict';
import test from 'node:test';
import { createVercelConfig } from './vercel-config.mjs';

test('builds the web workspace with the same-origin API base and ordered rewrites', () => {
  const config = createVercelConfig({
    renderApiOrigin: 'https://lumen-api.onrender.com',
    vercelDeploymentHosts: ['lumen-social.vercel.app'],
  });

  assert.equal(config.framework, 'vite');
  assert.equal(config.outputDirectory, 'apps/web/dist');
  assert.match(config.buildCommand, /VITE_API_URL=\/api/);
  assert.deepEqual(config.rewrites, [
    {
      source: '/api/:path*',
      destination: 'https://lumen-api.onrender.com/api/:path*',
    },
    {
      source: '/:path*',
      destination: '/index.html',
    },
  ]);
});

test('requires an explicit HTTPS API origin', () => {
  for (const renderApiOrigin of [
    undefined,
    'not a URL',
    'http://lumen-api.onrender.com',
    'https://user:password@lumen-api.onrender.com',
    'https://lumen-api.onrender.com/path',
    'https://localhost',
  ]) {
    assert.throws(
      () => createVercelConfig({ renderApiOrigin }),
      /RENDER_API_ORIGIN/,
    );
  }
});

test('rejects a Vercel origin as the API target to prevent rewrite loops', () => {
  assert.throws(
    () =>
      createVercelConfig({
        renderApiOrigin: 'https://lumen-social.vercel.app',
      }),
    /RENDER_API_ORIGIN/,
  );

  assert.throws(
    () =>
      createVercelConfig({
        renderApiOrigin: 'https://lumen-api.onrender.com',
        vercelDeploymentHosts: [
          'lumen-social.example.edu',
          'lumen-api.onrender.com',
        ],
      }),
    /RENDER_API_ORIGIN/,
  );
});
