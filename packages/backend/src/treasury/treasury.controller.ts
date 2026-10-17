import {
  Controller,
  Get,
  Query,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { TreasuryService } from './treasury.service';
import { TreasurySummaryQueryDto } from './dto/treasury-summary.dto';
import { TreasuryHistoryQueryDto } from './dto/treasury-history.dto';
import { TreasuryAnalyticsService } from './treasury-analytics.service';

@ApiTags('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/treasury')
export class TreasuryController {
  constructor(private readonly treasuryService: TreasuryService) {}

  @Get()
  @ApiOperation({ summary: 'Treasury totals broken down by token' })
  getSummary(
    @Query(new ValidationPipe({ transform: true }))
    query: TreasurySummaryQueryDto,
  ) {
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    return this.treasuryService.getSummary(from, to);
  }

  @Get('history')
  @ApiOperation({ summary: 'Treasury fee entry history (paginated)' })
  getHistory(
    @Query(new ValidationPipe({ transform: true }))
    query: TreasuryHistoryQueryDto,
  ) {
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    return this.treasuryService.getHistory({
      page: query.page ?? 1,
      limit: query.limit ?? 50,
      from,
      to,
      tokenAddress: query.tokenAddress,
    });
  }
}

/** BE-033 — public protocol analytics (TVL, volume, fees, retention). */
@ApiTags('treasury')
@Controller('treasury/analytics')
export class TreasuryAnalyticsController {
  constructor(private readonly analyticsService: TreasuryAnalyticsService) {}

  @Get('overview')
  @ApiOperation({
    summary:
      'Bucketed TVL, volume, fee split and cohort retention with growth metrics (5 min Redis cache)',
  })
  @ApiQuery({
    name: 'range',
    required: false,
    enum: ['24h', '7d', '30d', '90d', '1y'],
  })
  @ApiQuery({
    name: 'interval',
    required: false,
    enum: ['hour', 'day'],
    description: 'Defaults to hour for 24h/7d, day otherwise',
  })
  getOverview(
    @Query('range') range?: string,
    @Query('interval') interval?: string,
  ) {
    const parsed = TreasuryAnalyticsService.parseQuery(range, interval);
    return this.analyticsService.getOverview(parsed.range, parsed.interval);
  }
}
