import {
  fetchWithTimeout,
  PartnerHttpError,
  isRetryableStatusCode,
  redactSensitiveUrl,
} from './http-client.js';
import { requestContext } from '../middleware/request-id.middleware.js';

describe('PartnerHttpError & isRetryableStatusCode', () => {
  it('correctly identifies retryable vs non-retryable HTTP status codes', () => {
    // Retryable
    expect(isRetryableStatusCode(408)).toBe(true);
    expect(isRetryableStatusCode(429)).toBe(true);
    expect(isRetryableStatusCode(500)).toBe(true);
    expect(isRetryableStatusCode(502)).toBe(true);
    expect(isRetryableStatusCode(503)).toBe(true);
    expect(isRetryableStatusCode(504)).toBe(true);

    // Non-retryable
    expect(isRetryableStatusCode(200)).toBe(false);
    expect(isRetryableStatusCode(400)).toBe(false);
    expect(isRetryableStatusCode(401)).toBe(false);
    expect(isRetryableStatusCode(403)).toBe(false);
    expect(isRetryableStatusCode(404)).toBe(false);
    expect(isRetryableStatusCode(409)).toBe(false);
    expect(isRetryableStatusCode(422)).toBe(false);
  });

  it('records status code, isRetryable, and details when instantiated with options', () => {
    const error = new PartnerHttpError({
      message: 'Rate limit exceeded',
      status: 429,
      responseBody: '{"retryAfter": 30}',
      partnerSlug: 'partner_a',
      url: 'https://api.partner-a.com/bookings',
    });

    expect(error.status).toBe(429);
    expect(error.statusCode).toBe(429);
    expect(error.isRetryable).toBe(true);
    expect(error.responseBody).toBe('{"retryAfter": 30}');
    expect(error.partnerSlug).toBe('partner_a');
    expect(error.url).toBe('https://api.partner-a.com/bookings');
    expect(error.name).toBe('PartnerHttpError');
  });

  it('records non-retryable status codes correctly with positional constructor', () => {
    const error = new PartnerHttpError('Invalid booking payload', 400);

    expect(error.status).toBe(400);
    expect(error.statusCode).toBe(400);
    expect(error.isRetryable).toBe(false);
    expect(error.message).toBe('Invalid booking payload');
  });

  it('allows overriding isRetryable explicitly', () => {
    const error = new PartnerHttpError({
      message: 'Fatal 500 error that cannot be retried',
      status: 500,
      isRetryable: false,
    });

    expect(error.status).toBe(500);
    expect(error.isRetryable).toBe(false);
  });
});

describe('fetchWithTimeout', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns response on successful 2xx request', async () => {
    const mockResponse = new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    global.fetch = jest.fn().mockResolvedValue(mockResponse);

    const res = await fetchWithTimeout('https://api.partner.com/status', {
      timeoutMs: 1000,
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean };
    expect(data.success).toBe(true);
  });

  it('throws PartnerHttpError with status and isRetryable on non-2xx status', async () => {
    const errorBody = JSON.stringify({ error: 'Service Unavailable' });
    const mockResponse = new Response(errorBody, {
      status: 503,
      statusText: 'Service Unavailable',
    });
    global.fetch = jest.fn().mockResolvedValue(mockResponse);

    await expect(
      fetchWithTimeout('https://api.partner.com/inventory', {
        partnerSlug: 'partner_b',
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(PartnerHttpError);

    try {
      await fetchWithTimeout('https://api.partner.com/inventory', {
        partnerSlug: 'partner_b',
        timeoutMs: 1000,
      });
    } catch (err: any) {
      expect(err).toBeInstanceOf(PartnerHttpError);
      expect(err.status).toBe(503);
      expect(err.isRetryable).toBe(true);
      expect(err.partnerSlug).toBe('partner_b');
      expect(err.responseBody).toBe(errorBody);
    }
  });

  it('does not throw on non-2xx when throwOnHttpError is false', async () => {
    const mockResponse = new Response('Not Found', { status: 404 });
    global.fetch = jest.fn().mockResolvedValue(mockResponse);

    const res = await fetchWithTimeout('https://api.partner.com/missing', {
      throwOnHttpError: false,
    });

    expect(res.status).toBe(404);
  });

  it('throws retryable PartnerHttpError with 408 on timeout', async () => {
    // Mock fetch that hangs until aborted
    global.fetch = jest.fn().mockImplementation((_url, init) => {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      });
    });

    await expect(
      fetchWithTimeout('https://api.partner.com/slow', {
        timeoutMs: 50,
        partnerSlug: 'partner_c',
      }),
    ).rejects.toThrow(PartnerHttpError);

    try {
      await fetchWithTimeout('https://api.partner.com/slow', {
        timeoutMs: 50,
        partnerSlug: 'partner_c',
      });
    } catch (err: any) {
      expect(err).toBeInstanceOf(PartnerHttpError);
      expect(err.status).toBe(408);
      expect(err.isRetryable).toBe(true);
      expect(err.message).toContain('timed out after 50ms');
      expect(err.partnerSlug).toBe('partner_c');
    }
  });

  it('automatically propagates x-request-id header when available in context', async () => {
    const mockFetch = jest.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    global.fetch = mockFetch;

    await requestContext.run({ requestId: 'ctx-req-id-999' }, async () => {
      await fetchWithTimeout('https://api.partner.com/test');
    });

    expect(mockFetch).toHaveBeenCalled();
    const calledInit = mockFetch.mock.calls[0][1];
    expect(calledInit.headers.get('x-request-id')).toBe('ctx-req-id-999');
  });

  it('redacts sensitive query parameter values from URL in logs and errors', () => {
    const raw = 'https://api.partner.com/v1/sync?apiKey=super_secret_123&token=my_bearer_token&property=prop1';
    const redacted = redactSensitiveUrl(raw);
    expect(redacted).not.toContain('super_secret_123');
    expect(redacted).not.toContain('my_bearer_token');
    expect(redacted).toContain('apiKey=%5BREDACTED%5D');
    expect(redacted).toContain('token=%5BREDACTED%5D');
    expect(redacted).toContain('property=prop1');
  });

  it('rejects disallowed URL protocols to prevent SSRF vulnerabilities', async () => {
    await expect(
      fetchWithTimeout('file:///etc/passwd'),
    ).rejects.toThrow(PartnerHttpError);

    await expect(
      fetchWithTimeout('javascript:alert(1)'),
    ).rejects.toThrow(PartnerHttpError);
  });
});
