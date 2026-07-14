import { afterEach, describe, expect, it } from 'vitest';
import { finderSecretLookup } from '../src/server/config-store';

const KEY = 'APPLYPILOT_USAJOBS_KEY';
const EMAIL = 'APPLYPILOT_USAJOBS_EMAIL';

afterEach(() => {
  delete process.env[KEY];
  delete process.env[EMAIL];
});

describe('finderSecretLookup — USAJOBS key mapping', () => {
  it('maps the connector key names to the .env values (via process.env)', () => {
    process.env[KEY] = 'abc123';
    process.env[EMAIL] = 'me@example.com';
    const get = finderSecretLookup('/does/not/exist.env');
    expect(get('keys.usajobs.api_key')).toBe('abc123');
    expect(get('keys.usajobs.user_agent_email')).toBe('me@example.com');
  });

  it('returns null for unset or unknown keys (paid aggregators stay unmapped)', () => {
    const get = finderSecretLookup('/does/not/exist.env');
    expect(get('keys.usajobs.api_key')).toBeNull();
    expect(get('keys.adzuna.app_id')).toBeNull();
    expect(get('keys.unknown')).toBeNull();
  });
});
