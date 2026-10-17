import { Test, TestingModule } from '@nestjs/testing';
import {
  TreasuryAnalyticsController,
  TreasuryController,
} from './treasury.controller';
import { TreasuryService } from './treasury.service';
import { TreasuryAnalyticsService } from './treasury-analytics.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

describe('TreasuryController', () => {
  let controller: TreasuryController;
  const service = {
    getSummary: jest.fn(),
    getHistory: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TreasuryController],
      providers: [{ provide: TreasuryService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(TreasuryController);
    jest.clearAllMocks();
  });

  it('delegates summary', async () => {
    service.getSummary.mockResolvedValue({ totalFees: '0', byToken: [] });
    await controller.getSummary({});
    expect(service.getSummary).toHaveBeenCalled();
  });
});

describe('TreasuryAnalyticsController (BE-033)', () => {
  let controller: TreasuryAnalyticsController;
  const analytics = {
    getOverview: jest.fn().mockResolvedValue({ labels: [] }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TreasuryAnalyticsController],
      providers: [{ provide: TreasuryAnalyticsService, useValue: analytics }],
    }).compile();
    controller = module.get(TreasuryAnalyticsController);
    jest.clearAllMocks();
  });

  it('validates the query and delegates to the service', async () => {
    await controller.getOverview('7d', undefined);
    expect(analytics.getOverview).toHaveBeenCalledWith('7d', 'hour');
  });

  it('rejects unsupported ranges', () => {
    expect(() => controller.getOverview('10y')).toThrow('range must be one of');
  });
});
