import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { SyncJobStatus } from '@cih/database';
import { AdminService } from './admin.service.js';
import { AdminApiKeyGuard } from '../../common/guards/admin-api-key.guard.js';

@Controller('admin')
@UseGuards(AdminApiKeyGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('partners')
  getPartners() {
    return this.adminService.getPartnersOverview();
  }

  @Get('jobs')
  getJobs(
    @Query('status') status?: SyncJobStatus,
    @Query('take') take?: string,
  ) {
    const safeTake = Math.min(Math.max(1, parseInt(take || '50', 10) || 50), 100);
    return this.adminService.getSyncJobs(status, safeTake);
  }

  @Post('jobs/:id/replay')
  replayJob(@Param('id') id: string) {
    return this.adminService.replaySyncJob(id);
  }

  @Get('reconciliation-logs')
  getReconciliationLogs(@Query('take') take?: string) {
    const safeTake = Math.min(Math.max(1, parseInt(take || '50', 10) || 50), 100);
    return this.adminService.getReconciliationLogs(safeTake);
  }

  @Post('reconciliation-logs/:id/resolve')
  resolveReconciliationLog(
    @Param('id') id: string,
    @Body() body: { action: 'ACCEPT_PARTNER' | 'KEEP_CANONICAL' | 'DISMISS' },
  ) {
    if (!body || !body.action) {
      throw new BadRequestException('Request body must contain "action"');
    }
    return this.adminService.resolveReconciliationLog(id, body.action);
  }

  @Post('reconcile/:partnerSlug')
  triggerReconciliation(@Param('partnerSlug') partnerSlug: string) {
    return this.adminService.triggerReconciliation(partnerSlug);
  }
}