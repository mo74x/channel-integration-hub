import { BadRequestException } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

describe('AdminController', () => {
  let controller: AdminController;
  let mockAdminService: jest.Mocked<Partial<AdminService>>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockAdminService = {
      getPartnersOverview: jest.fn().mockResolvedValue([]),
      getSyncJobs: jest.fn().mockResolvedValue([]),
      replaySyncJob: jest.fn().mockResolvedValue({ success: true } as any),
      getReconciliationLogs: jest.fn().mockResolvedValue([]),
      triggerReconciliation: jest.fn().mockResolvedValue({ partnerSlug: 'partner_a', driftDetected: 0 }),
      resolveReconciliationLog: jest.fn().mockResolvedValue({
        success: true,
        action: 'ACCEPT_PARTNER',
      } as any),
    };

    controller = new AdminController(mockAdminService as AdminService);
  });

  describe('POST /admin/reconciliation-logs/:id/resolve', () => {
    it('should throw BadRequestException if body or action is missing', async () => {
      await expect(
        controller.resolveReconciliationLog('log-1', null as any),
      ).rejects.toThrow(BadRequestException);

      await expect(
        controller.resolveReconciliationLog('log-1', {} as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should delegate resolution action to adminService.resolveReconciliationLog', async () => {
      const result = await controller.resolveReconciliationLog('log-1', {
        action: 'ACCEPT_PARTNER',
      });

      expect(mockAdminService.resolveReconciliationLog).toHaveBeenCalledWith(
        'log-1',
        'ACCEPT_PARTNER',
      );
      expect(result.success).toBe(true);
    });

    it('should support KEEP_CANONICAL and DISMISS actions', async () => {
      await controller.resolveReconciliationLog('log-2', {
        action: 'KEEP_CANONICAL',
      });
      expect(mockAdminService.resolveReconciliationLog).toHaveBeenCalledWith(
        'log-2',
        'KEEP_CANONICAL',
      );

      await controller.resolveReconciliationLog('log-3', {
        action: 'DISMISS',
      });
      expect(mockAdminService.resolveReconciliationLog).toHaveBeenCalledWith(
        'log-3',
        'DISMISS',
      );
    });
  });
});
