import { validateEnv } from './env.validation.js';

describe('validateEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should successfully validate and apply default values when provided minimal valid config', () => {
    const config = {
      DATABASE_URL:
        'postgresql://cih_user:cih_secure_password@localhost:5432/channel_hub?schema=public',
    };

    const validated = validateEnv(config);

    expect(validated.NODE_ENV).toBe('development');
    expect(validated.API_PORT).toBe(3000);
    expect(validated.REDIS_HOST).toBe('localhost');
    expect(validated.REDIS_PORT).toBe(6379);
    expect(validated.PARTNER_A_API_KEY).toBe('cih_live_partner_a_key_98765');
  });

  it('should coerce numeric strings for port values', () => {
    const config = {
      API_PORT: '8080',
      REDIS_PORT: '6380',
    };

    const validated = validateEnv(config);

    expect(validated.API_PORT).toBe(8080);
    expect(validated.REDIS_PORT).toBe(6380);
  });

  it('should fail fast with descriptive error message if invalid NODE_ENV is provided', () => {
    const config = {
      NODE_ENV: 'invalid_environment_name',
    };

    expect(() => validateEnv(config)).toThrow(
      /Environment variable validation failed at application boot/,
    );
  });

  it('should fail fast if an invalid URL is provided for partner base URLs', () => {
    const config = {
      PARTNER_A_BASE_URL: 'not-a-valid-url',
    };

    expect(() => validateEnv(config)).toThrow(/Invalid url/);
  });

  it('should reject default dev secrets when NODE_ENV is production', () => {
    const config = {
      NODE_ENV: 'production',
      ADMIN_API_KEY: 'cih_admin_secret_key_dev',
    };

    expect(() => validateEnv(config)).toThrow(
      /Default development secrets.*must be replaced with strong unique secrets in production/,
    );
  });

  it('should pass production validation when strong unique secrets are provided', () => {
    const config = {
      NODE_ENV: 'production',
      ADMIN_API_KEY: 'prod_admin_very_strong_key_9999',
      PARTNER_C_HMAC_SECRET: 'prod_hmac_secret_43875892347923847',
      PARTNER_B_CLIENT_SECRET: 'prod_client_secret_38479238479',
    };

    const validated = validateEnv(config);
    expect(validated.NODE_ENV).toBe('production');
    expect(validated.ADMIN_API_KEY).toBe('prod_admin_very_strong_key_9999');
  });
});
