import { getRequestId } from '../middleware/request-id.middleware.js';

/**
 * Returns true if the HTTP status code represents a transient, retryable failure.
 * Specifically:
 * - 408: Request Timeout
 * - 429: Too Many Requests (Rate limit)
 * - 500: Internal Server Error
 * - 502: Bad Gateway
 * - 503: Service Unavailable
 * - 504: Gateway Timeout
 */
export function isRetryableStatusCode(status: number): boolean {
  return [408, 429, 500, 502, 503, 504].includes(status);
}

export interface PartnerHttpErrorOptions {
  message?: string;
  status: number;
  isRetryable?: boolean;
  responseBody?: string;
  partnerSlug?: string;
  url?: string;
  cause?: unknown;
}

/**
 * Error thrown when an outbound HTTP call to a partner fails or times out.
 * Records the HTTP status code and whether the failure is retryable.
 */
export class PartnerHttpError extends Error {
  readonly status: number;
  readonly statusCode: number;
  readonly isRetryable: boolean;
  readonly responseBody?: string;
  readonly partnerSlug?: string;
  readonly url?: string;

  constructor(
    messageOrOptions: string | PartnerHttpErrorOptions,
    status?: number,
    isRetryable?: boolean,
    details?: { responseBody?: string; partnerSlug?: string; url?: string; cause?: unknown },
  ) {
    if (typeof messageOrOptions === 'object') {
      const opts = messageOrOptions;
      const computedRetryable =
        opts.isRetryable !== undefined ? opts.isRetryable : isRetryableStatusCode(opts.status);
      const msg = opts.message || `Partner HTTP call failed with status ${opts.status}`;
      super(msg, { cause: opts.cause });
      this.name = 'PartnerHttpError';
      this.status = opts.status;
      this.statusCode = opts.status;
      this.isRetryable = computedRetryable;
      this.responseBody = opts.responseBody;
      this.partnerSlug = opts.partnerSlug;
      this.url = opts.url;
    } else {
      const st = status ?? 500;
      const computedRetryable =
        isRetryable !== undefined ? isRetryable : isRetryableStatusCode(st);
      super(messageOrOptions, { cause: details?.cause });
      this.name = 'PartnerHttpError';
      this.status = st;
      this.statusCode = st;
      this.isRetryable = computedRetryable;
      this.responseBody = details?.responseBody;
      this.partnerSlug = details?.partnerSlug;
      this.url = details?.url;
    }

    Object.setPrototypeOf(this, PartnerHttpError.prototype);
  }
}

export interface FetchWithTimeoutOptions extends RequestInit {
  /**
   * Timeout in milliseconds. Defaults to 10,000ms (10 seconds).
   */
  timeoutMs?: number;

  /**
   * Partner identifier slug for logging and error reporting.
   */
  partnerSlug?: string;

  /**
   * If true (default), throws PartnerHttpError when response.ok is false.
   */
  throwOnHttpError?: boolean;
}

/**
 * Wraps global fetch with timeout support and automatically propagates x-request-id.
 * Throws PartnerHttpError when the request fails, times out, or returns a non-2xx response.
 */
export async function fetchWithTimeout(
  input: string | URL | Request,
  options: FetchWithTimeoutOptions = {},
): Promise<Response> {
  const {
    timeoutMs = 10000,
    partnerSlug,
    throwOnHttpError = true,
    signal: callerSignal,
    headers: originalHeaders,
    ...restOptions
  } = options;

  const urlStr =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort(new Error(`Timeout of ${timeoutMs}ms exceeded`));
  }, timeoutMs);

  let combinedSignal: AbortSignal;
  if (callerSignal) {
    if (typeof AbortSignal.any === 'function') {
      combinedSignal = AbortSignal.any([callerSignal, timeoutController.signal]);
    } else {
      const combinedController = new AbortController();
      callerSignal.addEventListener('abort', () =>
        combinedController.abort(callerSignal.reason),
      );
      timeoutController.signal.addEventListener('abort', () =>
        combinedController.abort(timeoutController.signal.reason),
      );
      combinedSignal = combinedController.signal;
    }
  } else {
    combinedSignal = timeoutController.signal;
  }

  // Propagate x-request-id if available from active request context
  const reqId = getRequestId();
  const requestHeaders = new Headers(originalHeaders || {});
  if (reqId && !requestHeaders.has('x-request-id')) {
    requestHeaders.set('x-request-id', reqId);
  }

  try {
    const response = await fetch(input, {
      ...restOptions,
      headers: requestHeaders,
      signal: combinedSignal,
    });

    if (!response.ok && throwOnHttpError) {
      const responseBody = await response.text().catch(() => '');
      throw new PartnerHttpError({
        message: `Partner HTTP request to ${urlStr} failed with status ${response.status}`,
        status: response.status,
        isRetryable: isRetryableStatusCode(response.status),
        responseBody,
        partnerSlug,
        url: urlStr,
      });
    }

    return response;
  } catch (error) {
    if (error instanceof PartnerHttpError) {
      throw error;
    }

    if (timeoutController.signal.aborted) {
      throw new PartnerHttpError({
        message: `Request to ${urlStr} timed out after ${timeoutMs}ms`,
        status: 408,
        isRetryable: true,
        partnerSlug,
        url: urlStr,
        cause: error,
      });
    }

    if (callerSignal?.aborted) {
      throw error;
    }

    // Network / connection errors
    throw new PartnerHttpError({
      message: `Network error requesting ${urlStr}: ${error instanceof Error ? error.message : String(error)}`,
      status: 503,
      isRetryable: true,
      partnerSlug,
      url: urlStr,
      cause: error,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
