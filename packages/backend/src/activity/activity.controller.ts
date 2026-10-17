import {
  Controller,
  Get,
  Param,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { ActivityService } from './activity.service';
import { ActivityType } from './entities/activity.entity';

@Controller('users')
export class ActivityController {
  constructor(private readonly activityService: ActivityService) {}

  @Get(':address/activity')
  async getUserActivity(
    @Param('address') address: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('type') type?: ActivityType,
  ) {
    return this.activityService.getUserActivity(address, page, limit, type);
  }

  @Get(':address/feed')
  async getFriendFeed(
    @Param('address') address: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('type') type?: ActivityType,
  ) {
    return this.activityService.getFriendFeed(address, page, limit, type);
  }
}
