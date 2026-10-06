import { ArgumentsHost, BadRequestException, HttpStatus, NotFoundException } from '@nestjs/common';
import { Prisma } from '@cih/database';
import { AllExceptionsFilter, ErrorResponseEnvelope } from './all-exceptions.filter.js';

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let mockResponse: {
    status: jest.Mock;
    json: jest.Mock;
    setHeader: jest.Mock;
  };
  let mockRequest: {
    url: string;
    method: string;
    headers: Record<string, string>;
  };
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
    };
    mockRequest = {
      url: '/test-endpoint',
      method: 'POST',
      headers: {},
    };
    mockHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as unknown as ArgumentsHost;
  });

  it('should format standard HttpException with consistent envelope and pass through existing requestId', () => {
    mockRequest.headers['x-request-id'] = 'custom-request-id-123';
    const exception = new BadRequestException('Validation failed for booking');

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(mockResponse.setHeader).toHaveBeenCalledWith('x-request-id', 'custom-request-id-123');

    const responseBody: ErrorResponseEnvelope = mockResponse.json.mock.calls[0][0];
    expect(responseBody.statusCode).toBe(400);
    expect(responseBody.error).toBe('Bad Request');
    expect(responseBody.message).toBe('Validation failed for booking');
    expect(responseBody.requestId).toBe('custom-request-id-123');
    expect(responseBody.path).toBe('/test-endpoint');
    expect(responseBody.timestamp).toBeDefined();
  });

  it('should generate a UUID requestId if not provided in headers', () => {
    const exception = new NotFoundException('Resource missing');

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    const responseBody: ErrorResponseEnvelope = mockResponse.json.mock.calls[0][0];
    expect(responseBody.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('should map Prisma P2002 (Unique constraint) error to 409 Conflict', () => {
    const prismaError = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`partnerId`,`externalBookingId`)',
      {
        code: 'P2002',
        clientVersion: '7.10.0',
        meta: { target: ['partnerId', 'externalBookingId'] },
      },
    );

    filter.catch(prismaError, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    const responseBody: ErrorResponseEnvelope = mockResponse.json.mock.calls[0][0];
    expect(responseBody.statusCode).toBe(409);
    expect(responseBody.error).toBe('Conflict');
    expect(responseBody.message).toContain('Unique constraint violation on partnerId, externalBookingId');
  });

  it('should map Prisma P2025 (Record not found) error to 404 Not Found', () => {
    const prismaError = new Prisma.PrismaClientKnownRequestError(
      'Record to update not found',
      {
        code: 'P2025',
        clientVersion: '7.10.0',
        meta: { cause: 'No Reservation found' },
      },
    );

    filter.catch(prismaError, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    const responseBody: ErrorResponseEnvelope = mockResponse.json.mock.calls[0][0];
    expect(responseBody.statusCode).toBe(404);
    expect(responseBody.error).toBe('Not Found');
    expect(responseBody.message).toBe('No Reservation found');
  });

  it('should map Prisma P2003 (Foreign key constraint violation) error to 400 Bad Request', () => {
    const prismaError = new Prisma.PrismaClientKnownRequestError(
      'Foreign key constraint failed',
      {
        code: 'P2003',
        clientVersion: '7.10.0',
      },
    );

    filter.catch(prismaError, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    const responseBody: ErrorResponseEnvelope = mockResponse.json.mock.calls[0][0];
    expect(responseBody.statusCode).toBe(400);
    expect(responseBody.error).toBe('Bad Request');
    expect(responseBody.message).toBe('Foreign key constraint violation');
  });

  it('should map generic unhandled Error to 500 Internal Server Error', () => {
    const unhandledError = new Error('Database connection unexpectedly dropped');

    filter.catch(unhandledError, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    const responseBody: ErrorResponseEnvelope = mockResponse.json.mock.calls[0][0];
    expect(responseBody.statusCode).toBe(500);
    expect(responseBody.error).toBe('Internal Server Error');
  });
});
