import { BadRequestException } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { PartnerStatus } from '@cih/database';

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
      resetPartnerCircuit: jest.fn().mockResolvedValue({
        success: true,
        partnerSlug: 'partner_a',
        circuitState: 'CLOSED',
        consecutiveFailures: 0,
      } as any),
      updatePartnerStatus: jest.fn().mockResolvedValue({
        success: true,
        partner: { id: 'p-1', slug: 'partner_a', status: PartnerStatus.DISABLED },
      } as any),
    };

    controller = new AdminController(mockAdminService as AdminService);
  });

  describe('POST /admin/partners/:slug/circuit/reset', () => {
    it('should delegate circuit reset to adminService.resetPartnerCircuit', async () => {
      const result = await controller.resetPartnerCircuit('partner_a');

      expect(mockAdminService.resetPartnerCircuit).toHaveBeenCalledWith('partner_a');
      expect(result.success).toBe(true);
      expect(result.circuitState).toBe('CLOSED');
    });
  });

  describe('PATCH /admin/partners/:slug', () => {
    it('should delegate partner enable/disable to adminService.updatePartnerStatus', async () => {
      const body = { enabled: false };
      const result = await controller.updatePartnerStatus('partner_a', body);

      expect(mockAdminService.updatePartnerStatus).toHaveBeenCalledWith('partner_a', body);
      expect(result.success).toBe(true);
      expect(result.partner.status).toBe(PartnerStatus.DISABLED);
    });

    it('should delegate status update with explicit status enum', async () => {
      const body = { status: PartnerStatus.ACTIVE };
      await controller.updatePartnerStatus('partner_b', body);

      expect(mockAdminService.updatePartnerStatus).toHaveBeenCalledWith('partner_b', body);
    });
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
