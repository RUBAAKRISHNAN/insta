import { describe, expect, it } from 'vitest';
import { resolveApiBaseUrl } from './api-base-url.js';

describe('API base URL configuration', () => {
  it('uses localhost by default for development', () => {
    expect(resolveApiBaseUrl(false, undefined)).toBe('http://localhost:4000/api');
  });

  it('preserves an explicitly configured development API URL', () => {
    expect(resolveApiBaseUrl(false, 'http://127.0.0.1:4100/api')).toBe(
      'http://127.0.0.1:4100/api',
    );
  });

  it('accepts the same-origin production API path', () => {
    expect(resolveApiBaseUrl(true, '/api')).toBe('/api');
  });

  it('accepts an explicit HTTPS production API URL', () => {
    expect(resolveApiBaseUrl(true, 'https://api.lumen-demo.example/api')).toBe(
      'https://api.lumen-demo.example/api',
    );
  });

  it.each([
    ['missing URL', undefined],
    ['localhost fallback', 'http://localhost:4000/api'],
    ['HTTP URL', 'http://api.lumen-demo.example/api'],
    ['URL without API path', 'https://api.lumen-demo.example'],
    ['credential-bearing URL', 'https://user:pass@api.lumen-demo.example/api'],
  ])('rejects production %s', (_description, value) => {
    expect(() => resolveApiBaseUrl(true, value)).toThrow(/Production builds require VITE_API_URL/);
  });
});
