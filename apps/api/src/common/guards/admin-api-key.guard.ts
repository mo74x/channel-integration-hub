import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { safeCompare } from '../crypto/safe-compare.js';

@Injectable()
export class AdminApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(AdminApiKeyGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const expectedKey = process.env.ADMIN_API_KEY;

    if (!expectedKey) {
      this.logger.error('ADMIN_API_KEY is not configured in the environment.');
      throw new UnauthorizedException('Admin authentication is misconfigured');
    }

    // Support x-admin-api-key, x-api-key, or Authorization: Bearer <key> / ApiKey <key>
    const headerKey =
      request.headers['x-admin-api-key'] ||
      request.headers['x-api-key'] ||
      request.headers['x-admin-key'];
    let providedKey = Array.isArray(headerKey) ? headerKey[0] : headerKey;

    if (!providedKey) {
      const authHeader = request.headers['authorization'];
      const authString = Array.isArray(authHeader) ? authHeader[0] : authHeader;
      if (authString) {
        const parts = authString.split(' ');
        if (parts.length === 2 && ['bearer', 'apikey'].includes(parts[0].toLowerCase())) {
          providedKey = parts[1];
        }
      }
    }

    if (!providedKey || !safeCompare(providedKey, expectedKey)) {
      this.logger.warn(
        `Unauthorized admin access attempt from IP ${request.ip || request.socket.remoteAddress} on ${request.method} ${request.originalUrl || request.url}`,
      );
      throw new UnauthorizedException('Invalid or missing Admin API Key');
    }

    return true;
  }
}
