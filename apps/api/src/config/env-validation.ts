import { z } from 'zod';

const localhostHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return (
    localhostHosts.has(host) ||
    host.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    host === '::'
  );
}

function isProductionOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.origin === value &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !isLocalHost(url.hostname)
    );
  } catch {
    return false;
  }
}

function isProductionDatabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'postgresql:' &&
      url.hostname.length > 0 &&
      url.pathname.length > 1 &&
      !url.hash &&
      !isLocalHost(url.hostname)
    );
  } catch {
    return false;
  }
}

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    WEB_ORIGIN: z.string().url().optional(),
    DATABASE_URL: z.string().url().startsWith('postgresql://').optional(),
    IMAGE_STORAGE: z.enum(['local', 'database']).default('local'),
    IMAGE_UPLOAD_DIR: z.string().min(1).optional(),
  })
  .superRefine((values, context) => {
    const productionConfigurationDetected =
      (values.WEB_ORIGIN?.startsWith('https://') ?? false) ||
      (values.DATABASE_URL !== undefined &&
        isProductionDatabaseUrl(values.DATABASE_URL));
    if (!values.NODE_ENV && productionConfigurationDetected) {
      context.addIssue({
        code: 'custom',
        path: ['NODE_ENV'],
        message: 'NODE_ENV must be explicitly set for production configuration.',
      });
    }

    if (values.NODE_ENV !== 'production') return;

    if (!values.DATABASE_URL || !isProductionDatabaseUrl(values.DATABASE_URL)) {
      context.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'A valid non-local PostgreSQL database URL is required in production.',
      });
    }

    if (!values.WEB_ORIGIN || !isProductionOrigin(values.WEB_ORIGIN)) {
      context.addIssue({
        code: 'custom',
        path: ['WEB_ORIGIN'],
        message: 'A valid HTTPS web origin is required in production.',
      });
    }
  })
  .transform((values) => ({
    ...values,
    NODE_ENV: values.NODE_ENV ?? 'development',
    WEB_ORIGIN: values.WEB_ORIGIN ?? 'http://localhost:5173',
  }));

export function parseApiEnvironment(environment: NodeJS.ProcessEnv) {
  return environmentSchema.safeParse(environment);
}
