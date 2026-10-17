/// <reference types="multer" />
import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { SocialGraphService } from './social-graph.service';
import { CreateProfileDto, UpdateProfileDto } from './dto/profile.dto';

describe('UsersController', () => {
  let controller: UsersController;

  const mockUsersService = {
    follow: jest.fn(),
    unfollow: jest.fn(),
    getFollowers: jest.fn(),
    getFollowing: jest.fn(),
    getUserByAddress: jest.fn(),
    createProfile: jest.fn(),
    updateProfile: jest.fn(),
    toggleFollow: jest.fn(),
  };

  const mockSocialGraphService = {
    getSecondDegreeConnections: jest.fn(),
    getTopCoBackers: jest.fn(),
    getTopRivals: jest.fn(),
    getAffinity: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: mockUsersService,
        },
        { provide: SocialGraphService, useValue: mockSocialGraphService },
      ],
    }).compile();

    controller = module.get<UsersController>(UsersController);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('social graph (BE-034)', () => {
    it('toggles follow using the body follower', async () => {
      mockUsersService.toggleFollow.mockResolvedValue({ following: true });
      await controller.toggleFollow('GB', { followerAddress: 'GA' });
      expect(mockUsersService.toggleFollow).toHaveBeenCalledWith('GA', 'GB');
    });

    it('routes network, co-backer, rival and affinity queries', async () => {
      await controller.getSecondDegree('GA', 10);
      await controller.getCoBackers('GA', 5);
      await controller.getRivals('GA', 5);
      await controller.getAffinity('GA', 'GB');
      expect(
        mockSocialGraphService.getSecondDegreeConnections,
      ).toHaveBeenCalledWith('GA', 10);
      expect(mockSocialGraphService.getTopCoBackers).toHaveBeenCalledWith(
        'GA',
        5,
      );
      expect(mockSocialGraphService.getTopRivals).toHaveBeenCalledWith('GA', 5);
      expect(mockSocialGraphService.getAffinity).toHaveBeenCalledWith(
        'GA',
        'GB',
      );
    });
  });

  describe('profile CRUD', () => {
    it('should create a profile', async () => {
      const dto: CreateProfileDto = {
        walletAddress: 'GC1',
        displayName: 'Alice',
        bio: 'Hello',
      };
      const file = {
        buffer: Buffer.from('test'),
        originalname: 'avatar.png',
      } as unknown as Express.Multer.File;
      mockUsersService.createProfile.mockResolvedValue({ id: 'u1', ...dto });

      const result = await controller.createProfile(dto, file);

      expect(mockUsersService.createProfile).toHaveBeenCalledWith(dto, file);
      expect(result.displayName).toBe('Alice');
    });

    it('should update a profile', async () => {
      const dto: UpdateProfileDto = {
        walletAddress: 'GC1',
        displayName: 'AliceUpdated',
      };
      const file = undefined;
      mockUsersService.updateProfile.mockResolvedValue({
        id: 'u1',
        walletAddress: 'GC1',
        displayName: 'AliceUpdated',
      });

      const result = await controller.updateProfile(dto, file);

      expect(mockUsersService.updateProfile).toHaveBeenCalledWith(dto, file);
      expect(result.displayName).toBe('AliceUpdated');
    });

    it('should get a profile by address', async () => {
      mockUsersService.getUserByAddress.mockResolvedValue({
        id: 'u1',
        walletAddress: 'GC1',
      });

      const result = await controller.getProfile('GC1');

      expect(mockUsersService.getUserByAddress).toHaveBeenCalledWith('GC1');
      expect(result.walletAddress).toBe('GC1');
    });
  });
});
