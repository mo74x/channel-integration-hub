process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://cih_user:cih_secure_password@localhost:5432/channel_hub?schema=public';
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'cih_admin_secret_key_dev';
process.env.PARTNER_A_API_KEY = process.env.PARTNER_A_API_KEY || 'cih_live_partner_a_key_98765';
process.env.PARTNER_B_CLIENT_ID = process.env.PARTNER_B_CLIENT_ID || 'client_b_channel_corp';
process.env.PARTNER_B_CLIENT_SECRET = process.env.PARTNER_B_CLIENT_SECRET || 'secret_b_oauth_token_val';
process.env.PARTNER_C_HMAC_SECRET = process.env.PARTNER_C_HMAC_SECRET || 'c8f126f5e92be2b1a8f940821d3e86f8';
process.env.PARTNER_D_API_KEY = process.env.PARTNER_D_API_KEY || 'cih_live_partner_d_key_112233';
