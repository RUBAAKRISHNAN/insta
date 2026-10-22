const localHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

function parseHttpsOrigin(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const isLocalHost =
      localHosts.has(hostname) ||
      hostname.endsWith('.localhost') ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname);

    if (
      url.protocol !== 'https:' ||
      url.origin !== value ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      isLocalHost
    ) {
      return undefined;
    }

    return { origin: url.origin, hostname };
  } catch {
    return undefined;
  }
}

function parseVercelDeploymentHost(value) {
  if (!value) return undefined;
  const host = value.startsWith('https://') ? value : `https://${value}`;
  return parseHttpsOrigin(host);
}

export function createVercelConfig({
  renderApiOrigin,
  vercelDeploymentHosts = [],
} = {}) {
  const api = renderApiOrigin ? parseHttpsOrigin(renderApiOrigin) : undefined;
  const deploymentOrigins = vercelDeploymentHosts
    .map(parseVercelDeploymentHost)
    .filter(Boolean)
    .map(({ origin }) => origin);

  if (
    !api ||
    api.hostname.endsWith('.vercel.app') ||
    deploymentOrigins.includes(api.origin)
  ) {
    throw new Error(
      'Set RENDER_API_ORIGIN to the Render API HTTPS origin, not a Vercel or local origin.',
    );
  }

  return {
    framework: 'vite',
    buildCommand:
      'npm run build -w @lumen/shared && VITE_API_URL=/api npm run build -w @lumen/web',
    outputDirectory: 'apps/web/dist',
    rewrites: [
      {
        source: '/api/:path*',
        destination: `${api.origin}/api/:path*`,
      },
      {
        source: '/:path*',
        destination: '/index.html',
      },
    ],
  };
}
