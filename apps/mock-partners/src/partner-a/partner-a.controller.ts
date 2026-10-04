import {
  Controller,
  Post,
  Body,
  Headers,
  UnauthorizedException,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';

@Controller('partner-a')
export class PartnerAController {
  private readonly logger = new Logger(PartnerAController.name);
  private readonly validApiKey = process.env.PARTNER_A_API_KEY || 'cih_live_partner_a_key_98765';

  @Post('inventory')
  @HttpCode(HttpStatus.OK)
  syncInventory(
    @Headers('x-api-key') apiKey: string,
    @Body() body: Record<string, unknown>,
  ) {
    if (!apiKey || apiKey !== this.validApiKey) {
      this.logger.warn(`Partner A: Unauthorized inventory push attempt. Received: ${apiKey}`);
      throw new UnauthorizedException('Invalid or missing x-api-key header');
    }

    this.logger.log(`Partner A: Inventory push accepted for room ${body['room_type_id']}`);
    return {
      success: true,
      acknowledgementId: `ack_a_${Date.now()}`,
      syncedAt: new Date().toISOString(),
    };
  }
}