import { describe, it, expect } from 'vitest';
import { getSecret, resolveSecret } from '../../src/secrets/keychain.js';

describe('secrets (env fallback)', () => {
  it('reads secrets from FLIGHTDECK_SECRET_* env vars', () => {
    process.env.FLIGHTDECK_SECRET_API_KEY = 'env-value';
    try {
      expect(getSecret('api_key')).toBe('env-value');
      expect(getSecret('API_KEY')).toBe('env-value');
      expect(getSecret('missing')).toBeNull();
    } finally {
      delete process.env.FLIGHTDECK_SECRET_API_KEY;
    }
  });

  it('resolveSecret throws when a secret is not set', () => {
    expect(() => resolveSecret('definitely-not-set')).toThrow(/not set/);
  });
});
