import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiSecurity,
  ApiOperation,
  ApiParam,
  ApiBody,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { AdminService } from './admin.service.js';
import { AdminApiKeyGuard } from '../../common/guards/admin-api-key.guard.js';
import {
  UpdatePartnerStatusDto,
  ResolveDriftDto,
  GetJobsQueryDto,
  GetReconciliationLogsQueryDto,
} from './dto/admin.dto.js';

@ApiTags('Admin')
@ApiSecurity('AdminApiKey')
@Controller('admin')
@UseGuards(AdminApiKeyGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('partners')
  @ApiOperation({ summary: 'List all partners', description: 'Returns all partners with real-time circuit breaker state and unresolved failure counts.' })
  @ApiOkResponse({ description: 'Array of partner overviews.' })
  getPartners() {
    return this.adminService.getPartnersOverview();
  }

  @Post('partners/:slug/circuit/reset')
  @ApiOperation({ summary: 'Reset circuit breaker', description: 'Force-resets the circuit breaker for a partner to CLOSED, clearing all failure counters and probe locks. Restores partner status to ACTIVE if it was CIRCUIT_OPEN.' })
  @ApiParam({ name: 'slug', description: 'Partner slug', example: 'partner_a' })
  @ApiOkResponse({ description: 'Circuit reset successfully.' })
  @ApiNotFoundResponse({ description: 'Partner not found.' })
  resetPartnerCircuit(@Param('slug') slug: string) {
    return this.adminService.resetPartnerCircuit(slug);
  }

  @Patch('partners/:slug')
  @ApiOperation({ summary: 'Update partner status', description: 'Enables or disables a partner. Re-enabling also resets the circuit breaker.' })
  @ApiParam({ name: 'slug', description: 'Partner slug', example: 'partner_b' })
  @ApiBody({ type: UpdatePartnerStatusDto, description: 'Status update payload.' })
  @ApiOkResponse({ description: 'Partner status updated.' })
  @ApiBadRequestResponse({ description: 'Invalid status value.' })
  @ApiNotFoundResponse({ description: 'Partner not found.' })
  updatePartnerStatus(
    @Param('slug') slug: string,
    @Body()
    body: UpdatePartnerStatusDto,
  ) {
    return this.adminService.updatePartnerStatus(slug, body);
  }

  @Get('jobs')
  @ApiOperation({ summary: 'List sync jobs', description: 'Returns sync jobs with optional status filter, ordered by creation date descending.' })
  @ApiOkResponse({ description: 'Array of sync jobs.' })
  getJobs(@Query() query: GetJobsQueryDto) {
    const safeTake = Math.min(Math.max(1, parseInt(query.take || '50', 10) || 50), 100);
    return this.adminService.getSyncJobs(query.status, safeTake);
  }

  @Post('jobs/:id/replay')
  @ApiOperation({ summary: 'Replay a failed job', description: 'Resets a FAILED or DEAD_LETTER job to QUEUED and re-enqueues it into BullMQ with fresh retry budget.' })
  @ApiParam({ name: 'id', description: 'Sync job UUID' })
  @ApiOkResponse({ description: 'Job re-enqueued successfully.' })
  @ApiBadRequestResponse({ description: 'Job is not in FAILED or DEAD_LETTER status.' })
  @ApiNotFoundResponse({ description: 'Job not found.' })
  replayJob(@Param('id') id: string) {
    return this.adminService.replaySyncJob(id);
  }

  @Get('reconciliation-logs')
  @ApiOperation({ summary: 'List reconciliation logs', description: 'Returns drift logs captured by reconciliation runs, ordered by creation date descending.' })
  @ApiOkResponse({ description: 'Array of drift reconciliation logs.' })
  getReconciliationLogs(@Query() query: GetReconciliationLogsQueryDto) {
    const safeTake = Math.min(Math.max(1, parseInt(query.take || '50', 10) || 50), 100);
    return this.adminService.getReconciliationLogs(safeTake);
  }

  @Post('reconciliation-logs/:id/resolve')
  @ApiOperation({ summary: 'Resolve a drift log', description: 'Applies a resolution action to a drift log: ACCEPT_PARTNER (apply partner state via state machine), KEEP_CANONICAL (retain DB state), or DISMISS.' })
  @ApiParam({ name: 'id', description: 'Reconciliation log UUID' })
  @ApiBody({ type: ResolveDriftDto, description: 'Resolution action.' })
  @ApiOkResponse({ description: 'Drift resolved.' })
  @ApiBadRequestResponse({ description: 'Invalid action or missing fields.' })
  @ApiNotFoundResponse({ description: 'Reconciliation log not found.' })
  async resolveReconciliationLog(
    @Param('id') id: string,
    @Body() body: ResolveDriftDto,
  ) {
    if (!body || !body.action) {
      throw new BadRequestException('Request body must contain "action"');
    }
    return this.adminService.resolveReconciliationLog(id, body.action);
  }

  @Post('reconcile/:partnerSlug')
  @ApiOperation({ summary: 'Trigger reconciliation sweep', description: 'Runs an immediate drift reconciliation against a partner, comparing remote reservations with canonical DB state.' })
  @ApiParam({ name: 'partnerSlug', description: 'Partner slug', example: 'partner_c' })
  @ApiOkResponse({ description: 'Reconciliation completed; returns drift count.' })
  triggerReconciliation(@Param('partnerSlug') partnerSlug: string) {
    return this.adminService.triggerReconciliation(partnerSlug);
  }
}

