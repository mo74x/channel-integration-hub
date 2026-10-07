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

@Controller('partner-d')
export class PartnerDController {
  private readonly logger = new Logger(PartnerDController.name);
  private readonly validApiKey = process.env.PARTNER_D_API_KEY || 'cih_live_partner_d_key_112233';

  @Post('inventory')
  @HttpCode(HttpStatus.OK)
  syncInventory(@Headers('x-api-key') apiKey: string, @Body() body: Record<string, unknown>) {
    if (!apiKey || apiKey !== this.validApiKey) {
      this.logger.warn(`Partner D: Unauthorized inventory push attempt. Received: ${apiKey}`);
      throw new UnauthorizedException('Invalid or missing x-api-key header');
    }

    this.logger.log(
      `Partner D: Inventory push accepted for unit ${body['unit_code'] || body['room_type_id']}`,
    );
    return {
      success: true,
      acknowledgementId: `ack_d_${Date.now()}`,
      syncedAt: new Date().toISOString(),
    };
  }
}
