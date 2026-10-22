const developmentApiBaseUrl = 'http://localhost:4000/api';

function isSafeProductionApiBaseUrl(value: string): boolean {
  if (value === '/api') return true;

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const isLocalHost =
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname === '0.0.0.0' ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname);

    return (
      url.protocol === 'https:' &&
      !isLocalHost &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.endsWith('/api')
    );
  } catch {
    return false;
  }
}

export function resolveApiBaseUrl(
  isProduction: boolean,
  configuredApiBaseUrl: string | undefined,
): string {
  const configured = configuredApiBaseUrl?.trim();
  if (!isProduction) return configured || developmentApiBaseUrl;

  if (!configured || !isSafeProductionApiBaseUrl(configured)) {
    throw new Error(
      'Production builds require VITE_API_URL to be "/api" or an HTTPS API URL ending in "/api".',
    );
  }
  return configured;
}
