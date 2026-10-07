import {
  Controller,
  Post,
  Get,
  Body,
  Headers,
  Query,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';

@Controller('partner-b')
export class PartnerBController {
  private readonly logger = new Logger(PartnerBController.name);

  // In-memory token registry for the simulation session
  private activeTokens = new Set<string>();

  // In-memory simulated PMS reservation state
  private simulatedReservations = [
    {
      pms_reservation_id: 'RES-B-9901',
      hotel_code: 'EXT-PROP-B-202',
      room_category: 'DELUXE_KING',
      guest_details: { full_name: 'Elena Rostova', email: 'elena@example.com' },
      booking_window: { start_date: '2026-11-10', end_date: '2026-11-14' },
      rooms_count: 1,
      financials: { total_amount: 1000.0, currency_code: 'USD' },
      current_status: 'BOOKED',
      modified_at: '2026-10-01T10:00:00.000Z',
    },
    {
      pms_reservation_id: 'RES-B-9902',
      hotel_code: 'EXT-PROP-B-202',
      room_category: 'STANDARD_QUEEN',
      guest_details: { full_name: 'Marcus Vance', email: 'marcus@example.com' },
      booking_window: { start_date: '2026-11-15', end_date: '2026-11-18' },
      rooms_count: 2,
      financials: { total_amount: 900.0, currency_code: 'USD' },
      current_status: 'BOOKED',
      modified_at: '2026-10-02T14:30:00.000Z',
    },
  ];

  @Post('oauth/token')
  issueOAuthToken(@Body() body: { grant_type: string; client_id: string; client_secret: string }) {
    const expectedId = process.env.PARTNER_B_CLIENT_ID || 'client_b_channel_corp';
    const expectedSecret = process.env.PARTNER_B_CLIENT_SECRET || 'secret_b_oauth_token_val';

    if (body.client_id !== expectedId || body.client_secret !== expectedSecret) {
      throw new UnauthorizedException('Invalid client credentials for Partner B');
    }

    const token = `pb_tok_${randomBytes(24).toString('hex')}`;
    this.activeTokens.add(token);

    this.logger.log('Partner B: Granted OAuth2 Bearer token');
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: 3600,
    };
  }

  @Get('reservations')
  pullReservations(@Headers('authorization') authHeader: string, @Query('since') since?: string) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Bearer token');
    }

    const token = authHeader.replace('Bearer ', '');
    if (!this.activeTokens.has(token)) {
      throw new UnauthorizedException('Expired or invalid Bearer token');
    }

    let records = this.simulatedReservations;
    if (since) {
      const sinceDate = new Date(since);
      records = records.filter((r) => new Date(r.modified_at) > sinceDate);
    }

    this.logger.log(`Partner B: Handed off ${records.length} reservations via polling`);
    return {
      status: 'SUCCESS',
      count: records.length,
      data: records,
    };
  }
}
