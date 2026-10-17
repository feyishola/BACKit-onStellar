import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Users } from './entities/users.entity';
import { Badge } from './entities/badge.entity';
import { Follow } from './entities/follow.entity';
import { UsersService } from './users.service';
import { SocialGraphService } from './social-graph.service';
import {
  SocialCallPosition,
  UserInteraction,
} from './entities/user-interaction.entity';
import { UsersController } from './users.controller';
import { AnalyticsModule } from '../analytics/analytics.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Users,
      Badge,
      Follow,
      UserInteraction,
      SocialCallPosition,
    ]),
    AnalyticsModule,
    NotificationsModule,
    StorageModule,
  ],
  controllers: [UsersController],
  providers: [UsersService, SocialGraphService],
  exports: [UsersService, SocialGraphService],
})
export class UsersModule {}
