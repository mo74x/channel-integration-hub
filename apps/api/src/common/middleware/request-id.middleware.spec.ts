import { Logger } from '@nestjs/common';
import {
  RequestIdMiddleware,
  requestIdMiddleware,
  getRequestId,
  requestContext,
} from './request-id.middleware.js';

describe('RequestIdMiddleware', () => {
  let middleware: RequestIdMiddleware;
  let mockRequest: any;
  let mockResponse: any;
  let nextFn: jest.Mock;

  beforeEach(() => {
    middleware = new RequestIdMiddleware();
    mockRequest = {
      headers: {},
    };
    mockResponse = {
      setHeader: jest.fn(),
    };
    nextFn = jest.fn();
  });

  it('should pass through existing x-request-id from request header', () => {
    const existingId = 'req-abc-12345';
    mockRequest.headers['x-request-id'] = existingId;

    let capturedIdInContext: string | undefined;
    nextFn.mockImplementation(() => {
      capturedIdInContext = getRequestId();
    });

    middleware.use(mockRequest, mockResponse, nextFn);

    expect(nextFn).toHaveBeenCalled();
    expect(mockRequest.headers['x-request-id']).toBe(existingId);
    expect(mockRequest.id).toBe(existingId);
    expect(mockResponse.setHeader).toHaveBeenCalledWith('x-request-id', existingId);
    expect(capturedIdInContext).toBe(existingId);
  });

  it('should generate a new UUID if x-request-id is missing', () => {
    let capturedIdInContext: string | undefined;
    nextFn.mockImplementation(() => {
      capturedIdInContext = getRequestId();
    });

    middleware.use(mockRequest, mockResponse, nextFn);

    expect(nextFn).toHaveBeenCalled();
    const generatedId = mockRequest.headers['x-request-id'];
    expect(generatedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(mockRequest.id).toBe(generatedId);
    expect(mockResponse.setHeader).toHaveBeenCalledWith('x-request-id', generatedId);
    expect(capturedIdInContext).toBe(generatedId);
  });

  it('should work with functional requestIdMiddleware helper', () => {
    const existingId = 'func-req-id-789';
    mockRequest.headers['x-request-id'] = existingId;

    let capturedIdInContext: string | undefined;
    nextFn.mockImplementation(() => {
      capturedIdInContext = getRequestId();
    });

    requestIdMiddleware(mockRequest, mockResponse, nextFn);

    expect(nextFn).toHaveBeenCalled();
    expect(mockResponse.setHeader).toHaveBeenCalledWith('x-request-id', existingId);
    expect(capturedIdInContext).toBe(existingId);
  });

  it('should format logger messages with [requestId] during active request context', () => {
    const testReqId = 'trace-id-logger-test';
    const logger = new Logger('TestContext');
    const logSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      requestContext.run({ requestId: testReqId }, () => {
        logger.log('Payment processed successfully');
      });

      expect(logSpy).toHaveBeenCalled();
      const output = logSpy.mock.calls.map((call) => call[0].toString()).join('');
      expect(output).toContain(`[${testReqId}] Payment processed successfully`);
    } finally {
      logSpy.mockRestore();
    }
  });
});
