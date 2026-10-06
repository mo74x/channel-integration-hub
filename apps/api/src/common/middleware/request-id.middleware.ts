import { Injectable, NestMiddleware, ConsoleLogger, LogLevel } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContextStore {
  requestId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContextStore>();

/**
 * Returns the current request ID from AsyncLocalStorage context if available.
 */
export function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

// Track whether ConsoleLogger has already been patched to avoid multiple wrappers
let isLoggerPatched = false;

/**
 * Patches NestJS ConsoleLogger.prototype to prepend [requestId] to log messages
 * whenever an active request context exists.
 */
export function patchConsoleLogger(): void {
  if (isLoggerPatched) {
    return;
  }

  const originalFormatMessage = ConsoleLogger.prototype['formatMessage'];

  ConsoleLogger.prototype['formatMessage'] = function (
    this: ConsoleLogger,
    logLevel: LogLevel,
    message: unknown,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
  ): string {
    const reqId = getRequestId();
    let formattedMessage = message;

    if (reqId) {
      if (typeof message === 'string') {
        if (!message.startsWith(`[${reqId}]`)) {
          formattedMessage = `[${reqId}] ${message}`;
        }
      } else if (typeof message === 'object' && message !== null) {
        formattedMessage = `[${reqId}] ${JSON.stringify(message)}`;
      }
    }

    return originalFormatMessage.call(
      this,
      logLevel,
      formattedMessage,
      pidMessage,
      formattedLogLevel,
      contextMessage,
      timestampDiff,
    );
  };

  isLoggerPatched = true;
}

// Auto-patch ConsoleLogger on import so all standard NestJS loggers receive the requestId
patchConsoleLogger();

/**
 * Custom ConsoleLogger implementation that explicitly prepends [requestId]
 * if configured directly in app.useLogger().
 */
export class RequestIdLogger extends ConsoleLogger {
  protected override formatMessage(
    logLevel: LogLevel,
    message: unknown,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
  ): string {
    const reqId = getRequestId();
    let formattedMessage = message;

    if (reqId) {
      if (typeof message === 'string') {
        if (!message.startsWith(`[${reqId}]`)) {
          formattedMessage = `[${reqId}] ${message}`;
        }
      } else if (typeof message === 'object' && message !== null) {
        formattedMessage = `[${reqId}] ${JSON.stringify(message)}`;
      }
    }

    return super.formatMessage(
      logLevel,
      formattedMessage,
      pidMessage,
      formattedLogLevel,
      contextMessage,
      timestampDiff,
    );
  }
}

/**
 * Middleware that passes through or generates an x-request-id header,
 * sets it on the response header, and enters an AsyncLocalStorage
 * context so every log line emitted during the request contains the requestId.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const rawHeader = req.headers['x-request-id'] || req.headers['X-Request-Id'];
    const existingId = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const requestId = existingId && existingId.trim().length > 0 ? existingId.trim() : randomUUID();

    // Standardize request-id across request object
    req.headers['x-request-id'] = requestId;
    (req as any).id = requestId;
    (req as any).requestId = requestId;

    // Pass through or attach to response header
    res.setHeader('x-request-id', requestId);

    // Enter AsyncLocalStorage context for the duration of the request
    requestContext.run({ requestId }, () => {
      next();
    });
  }
}

/**
 * Functional middleware variant for app.use(requestIdMiddleware)
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const middleware = new RequestIdMiddleware();
  middleware.use(req, res, next);
}
