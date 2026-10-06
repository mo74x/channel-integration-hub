import { Controller, Get, Post, Param, Query, ParseIntPipe, Optional } from '@nestjs/common';
import { SyncJobStatus } from '@cih/database';
import { AdminService } from './admin.service.js';

@Controller('admin')
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
    return this.adminService.getSyncJobs(status, take ? parseInt(take, 10) : 50);
  }

  @Post('jobs/:id/replay')
  replayJob(@Param('id') id: string) {
    return this.adminService.replaySyncJob(id);
  }

  @Get('reconciliation-logs')
  getReconciliationLogs(@Query('take') take?: string) {
    return this.adminService.getReconciliationLogs(take ? parseInt(take, 10) : 50);
  }

  @Post('reconcile/:partnerSlug')
  triggerReconciliation(@Param('partnerSlug') partnerSlug: string) {
    return this.adminService.triggerReconciliation(partnerSlug);
  }
}