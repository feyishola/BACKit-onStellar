import { Logger, Module } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TreasuryEntry } from './treasury-entry.entity';
import { TreasuryService } from './treasury.service';
import {
  TreasuryAnalyticsController,
  TreasuryController,
} from './treasury.controller';
import { PlatformConfigModule } from '../config/config.module';
import {
  TREASURY_ANALYTICS_REDIS,
  TreasuryAnalyticsService,
} from './treasury-analytics.service';

@Module({
  imports: [TypeOrmModule.forFeature([TreasuryEntry]), PlatformConfigModule],
  providers: [
    TreasuryService,
    TreasuryAnalyticsService,
    {
      provide: TREASURY_ANALYTICS_REDIS,
      inject: [NestConfigService],
      useFactory: (config: NestConfigService) => {
        const redis = new Redis(
          config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
          { lazyConnect: true, maxRetriesPerRequest: 1 },
        );
        redis.on('error', (err: Error) =>
          new Logger('TreasuryAnalyticsRedis').warn(err.message),
        );
        return redis;
      },
    },
  ],
  controllers: [TreasuryController, TreasuryAnalyticsController],
  exports: [TreasuryService, TreasuryAnalyticsService],
})
export class TreasuryModule {}
