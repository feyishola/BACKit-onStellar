import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { DailySnapshotService } from './daily-snapshot.service';

@ApiTags('Analytics')
@Controller('analytics/snapshots')
export class SnapshotsController {
  constructor(private readonly snapshotService: DailySnapshotService) {}

  @Get('protocol')
  @ApiOperation({ summary: 'Daily protocol snapshots (TVL, volume, calls)' })
  @ApiQuery({ name: 'from', required: false, example: '2026-01-01' })
  @ApiQuery({ name: 'to', required: false, example: '2026-01-31' })
  getProtocolSnapshots(@Query('from') from?: string, @Query('to') to?: string) {
    return this.snapshotService.getProtocolSnapshots(from, to);
  }

  @Get('users/:address')
  @ApiOperation({ summary: "A user's daily snapshot history" })
  @ApiParam({ name: 'address', description: 'Stellar wallet address' })
  @ApiQuery({ name: 'from', required: false, example: '2026-01-01' })
  @ApiQuery({ name: 'to', required: false, example: '2026-01-31' })
  getUserSnapshots(
    @Param('address') address: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.snapshotService.getUserSnapshots(address, from, to);
  }

  @Get('leaderboard/:date')
  @ApiOperation({
    summary: 'Leaderboard standings frozen at the end of a UTC day',
  })
  @ApiParam({ name: 'date', example: '2026-01-31' })
  getLeaderboardSnapshot(
    @Param('date') date: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('date must be YYYY-MM-DD');
    }
    return this.snapshotService.getLeaderboardSnapshot(date, page, limit);
  }
}
