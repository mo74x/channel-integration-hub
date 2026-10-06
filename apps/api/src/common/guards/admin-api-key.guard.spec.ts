import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AdminApiKeyGuard } from './admin-api-key.guard.js';

describe('AdminApiKeyGuard', () => {
  let guard: AdminApiKeyGuard;
  const originalEnv = process.env.ADMIN_API_KEY;

  beforeEach(() => {
    process.env.ADMIN_API_KEY = 'test_secret_admin_key_12345';
    guard = new AdminApiKeyGuard();
  });

  afterAll(() => {
    process.env.ADMIN_API_KEY = originalEnv;
  });

  function createMockContext(headers: Record<string, string | string[]>): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers,
          ip: '127.0.0.1',
          url: '/admin/partners',
          method: 'GET',
        }),
      }),
    } as unknown as ExecutionContext;
  }

  it('allows access when valid x-api-key header is provided', () => {
    const context = createMockContext({ 'x-api-key': 'test_secret_admin_key_12345' });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows access when valid Authorization Bearer header is provided', () => {
    const context = createMockContext({ authorization: 'Bearer test_secret_admin_key_12345' });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('throws UnauthorizedException when header is missing', () => {
    const context = createMockContext({});
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when provided key is invalid', () => {
    const context = createMockContext({ 'x-api-key': 'wrong_key' });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when environment key is not configured', () => {
    delete process.env.ADMIN_API_KEY;
    const context = createMockContext({ 'x-api-key': 'test_secret_admin_key_12345' });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });
});
