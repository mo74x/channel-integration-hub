import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';  
import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@cih/database';
import { PartnerHttpError } from '../http/http-client.js';

export interface ErrorResponseEnvelope {
  statusCode: number;
  error: string;
  message: string | string[];
  requestId: string;
  path: string;
  timestamp: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestId =
      (request.headers['x-request-id'] as string) ||
      (request as any).id ||
      randomUUID();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let error = 'Internal Server Error';
    let message: string | string[] = 'An unexpected internal error occurred';

    // 1. Handle standard NestJS HttpExceptions
    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'object' && res !== null) {
        const resObj = res as Record<string, any>;
        message = resObj.message || exception.message;
        error = resObj.error || HttpStatus[statusCode] || 'Http Exception';
      } else if (typeof res === 'string') {
        message = res;
        error = HttpStatus[statusCode] || 'Http Exception';
      }
    }
    // 2. Handle Prisma Known Request Errors
    else if (
      exception instanceof Prisma.PrismaClientKnownRequestError ||
      (typeof exception === 'object' &&
        exception !== null &&
        'code' in exception &&
        typeof (exception as any).code === 'string' &&
        (exception as any).code.startsWith('P'))
    ) {
      const prismaError = exception as Prisma.PrismaClientKnownRequestError;
      switch (prismaError.code) {
        case 'P2002': {
          statusCode = HttpStatus.CONFLICT;
          error = 'Conflict';
          const target = (prismaError.meta?.target as string[])?.join(', ') || 'field';
          message = `Unique constraint violation on ${target}`;
          break;
        }
        case 'P2025': {
          statusCode = HttpStatus.NOT_FOUND;
          error = 'Not Found';
          message = (prismaError.meta?.cause as string) || 'Record not found';
          break;
        }
        case 'P2003': {
          statusCode = HttpStatus.BAD_REQUEST;
          error = 'Bad Request';
          message = 'Foreign key constraint violation';
          break;
        }
        case 'P2014': {
          statusCode = HttpStatus.BAD_REQUEST;
          error = 'Bad Request';
          message = 'The change you are trying to make violates a required relationship';
          break;
        }
        default: {
          statusCode = HttpStatus.BAD_REQUEST;
          error = 'Database Error';
          message = `Database query failed with code ${prismaError.code}`;
          break;
        }
      }
    }
    // 3. Handle PartnerHttpError (outbound partner communication failures)
    else if (exception instanceof PartnerHttpError) {
      statusCode = exception.status >= 400 && exception.status < 600 ? exception.status : HttpStatus.BAD_GATEWAY;
      error = 'Upstream Partner Error';
      message =
        process.env.NODE_ENV === 'production'
          ? `Upstream partner service request failed with status ${statusCode}`
          : exception.message;
    }
    // 4. Fallback for unhandled generic errors
    else if (exception instanceof Error) {
      this.logger.error(
        `Unhandled exception for request [${requestId}] on ${request.method} ${request.url}: ${exception.message}`,
        exception.stack,
      );
      if (process.env.NODE_ENV !== 'production') {
        message = exception.message;
      }
    } else {
      this.logger.error(
        `Unknown non-error exception thrown for request [${requestId}] on ${request.method} ${request.url}:`,
        exception,
      );
    }

    const envelope: ErrorResponseEnvelope = {
      statusCode,
      error,
      message,
      requestId,
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    response.setHeader('x-request-id', requestId);
    response.status(statusCode).json(envelope);
  }
}
