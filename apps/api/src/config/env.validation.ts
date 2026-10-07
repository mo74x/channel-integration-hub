import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3000),

  // Database Connection
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .default('postgresql://cih_user:cih_secure_password@localhost:5432/channel_hub?schema=public'),

  // Redis Connection
  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().default('redis_secure_password'),

  // Admin Security
  ADMIN_API_KEY: z.string().min(1).default('cih_admin_secret_key_dev'),

  // Partner Integrations & Gateways
  PARTNER_A_API_KEY: z.string().min(1).default('cih_live_partner_a_key_98765'),
  PARTNER_A_BASE_URL: z.string().url().default('http://localhost:4000/partner-a'),
  PARTNER_B_CLIENT_ID: z.string().min(1).default('client_b_channel_corp'),
  PARTNER_B_CLIENT_SECRET: z.string().min(1).default('secret_b_oauth_token_val'),
  PARTNER_B_BASE_URL: z.string().url().default('http://localhost:4000/partner-b'),
  PARTNER_C_HMAC_SECRET: z.string().min(1).default('c8f126f5e92be2b1a8f940821d3e86f8'),
  PARTNER_C_BASE_URL: z.string().url().default('http://localhost:4000/partner-c'),
  PARTNER_D_API_KEY: z.string().min(1).default('cih_live_partner_d_key_112233'),
  PARTNER_D_BASE_URL: z.string().url().default('http://localhost:4000/partner-d'),

  // Circuit Breaker
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  CIRCUIT_BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(30000),

  // External APIs
  OPENAI_API_KEY: z.string().optional(),
})
  .refine(
    (data) => {
      if (data.NODE_ENV === 'production') {
        return (
          data.ADMIN_API_KEY !== 'cih_admin_secret_key_dev' &&
          data.PARTNER_C_HMAC_SECRET !== 'c8f126f5e92be2b1a8f940821d3e86f8' &&
          data.PARTNER_B_CLIENT_SECRET !== 'secret_b_oauth_token_val'
        );
      }
      return true;
    },
    {
      message:
        'Default development secrets (ADMIN_API_KEY, PARTNER_C_HMAC_SECRET, PARTNER_B_CLIENT_SECRET) must be replaced with strong unique secrets in production',
      path: ['ADMIN_API_KEY'],
    },
  );

export type EnvConfig = z.infer<typeof envSchema>;

/**
 * Validates environment variables at application startup.
 * Throws a descriptive Error if any required variable is missing or fails validation,
 * ensuring the application fails fast before initialization.
 */
export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    const errorMessages = result.error.errors.map(
      (err) => `  - [${err.path.join('.') || 'root'}]: ${err.message}`,
    );
    throw new Error(
      `[FATAL] Environment variable validation failed at application boot:\n${errorMessages.join('\n')}`,
    );
  }

  return result.data;
}
