import { describe, expect, it } from 'vitest';
import { parseApiEnvironment } from './env-validation.js';

const validProductionEnvironment = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://demo.invalid:5432/lumen_social',
  WEB_ORIGIN: 'https://lumen-demo.vercel.app',
};

describe('API environment validation', () => {
  it('preserves local development defaults', () => {
    const result = parseApiEnvironment({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.NODE_ENV).toBe('development');
      expect(result.data.WEB_ORIGIN).toBe('http://localhost:5173');
      expect(result.data.DATABASE_URL).toBeUndefined();
    }
  });

  it('accepts explicit production settings', () => {
    const result = parseApiEnvironment(validProductionEnvironment);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.NODE_ENV).toBe('production');
      expect(result.data.WEB_ORIGIN).toBe('https://lumen-demo.vercel.app');
    }
  });

  it('requires explicit production mode when production settings are supplied', () => {
    const { NODE_ENV: _nodeEnv, ...productionSettings } = validProductionEnvironment;
    const result = parseApiEnvironment(productionSettings);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path[0])).toContain('NODE_ENV');
    }
  });

  it.each([
    ['missing production database URL', { DATABASE_URL: undefined }],
    ['malformed database URL', { DATABASE_URL: 'not-a-url' }],
    ['non-PostgreSQL database URL', { DATABASE_URL: 'https://db.example.test/name' }],
    ['local database URL', { DATABASE_URL: 'postgresql://localhost:5432/lumen_social' }],
    ['missing production web origin', { WEB_ORIGIN: undefined }],
    ['HTTP web origin', { WEB_ORIGIN: 'http://lumen-demo.vercel.app' }],
    ['localhost web origin', { WEB_ORIGIN: 'https://localhost' }],
    ['web origin with a path', { WEB_ORIGIN: 'https://lumen-demo.vercel.app/app' }],
    ['web origin with credentials', { WEB_ORIGIN: 'https://user:pass@lumen-demo.vercel.app' }],
  ])('rejects %s', (_description, override) => {
    const result = parseApiEnvironment({
      ...validProductionEnvironment,
      ...override,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).not.toContain('pass');
      expect(result.error.message).not.toContain('lumen_social');
    }
  });

  it('does not expose database credentials in invalid configuration errors', () => {
    const result = parseApiEnvironment({
      ...validProductionEnvironment,
      DATABASE_URL: 'postgresql://demo.invalid:5432/lumen_social',
      WEB_ORIGIN: 'http://user:private-value@localhost:5173',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).not.toContain('private-value');
      expect(result.error.message).not.toContain('lumen_social');
    }
  });

  it('keeps NODE_ENV defaulted for local development', () => {
    const result = parseApiEnvironment({
      DATABASE_URL: 'postgresql://localhost:5432/lumen_social',
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.NODE_ENV).toBe('development');
  });
});
