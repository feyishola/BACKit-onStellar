/// <reference types="multer" />
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { Users } from './entities/users.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AnalyticsService } from '../analytics/analytics.service';
import { RegisterDto } from './dto/register.dto';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Inject } from '@nestjs/common';
import { Follow } from './entities/follow.entity';
import { NotificationPreferencesService } from '../notifications/notification-preferences.service';
import { IpfsService } from '../storage/ipfs.service';
import { CreateProfileDto, UpdateProfileDto } from './dto/profile.dto';
import { affectedRowCount, SocialGraphService } from './social-graph.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(Users)
    private readonly usersRepo: Repository<Users>,
    @InjectRepository(Follow)
    private readonly followsRepo: Repository<Follow>,
    private readonly analyticsService: AnalyticsService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly preferenceService: NotificationPreferencesService,
    private readonly ipfsService: IpfsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly socialGraphService: SocialGraphService,
  ) {}

  private generateReferralCode(): string {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  async findOrCreateByAddress(walletAddress: string): Promise<Users> {
    let user = await this.usersRepo.findOne({ where: { walletAddress } });
    if (!user) {
      user = this.usersRepo.create({
        walletAddress,
        referralCode: this.generateReferralCode(),
      });
      user = await this.usersRepo.save(user);
      // Default notification preferences on user creation
      await this.preferenceService
        .initializePreferences(walletAddress)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `Failed to initialize notification preferences for ${walletAddress}: ${msg}`,
          );
        });
    }
    return user;
  }

  async follow(followerAddress: string, followingAddress: string) {
    if (followerAddress === followingAddress) {
      throw new BadRequestException('You cannot follow yourself');
    }

    await this.findOrCreateByAddress(followerAddress);
    await this.findOrCreateByAddress(followingAddress);

    // Insert + both counter bumps commit atomically; ON CONFLICT makes
    // concurrent duplicate follows lose cleanly instead of double-counting.
    const result = await this.followsRepo.manager.transaction(async (em) => {
      const inserted = await em.query<Follow[]>(
        `INSERT INTO follows ("followerAddress", "followingAddress")
         VALUES ($1, $2)
         ON CONFLICT ("followerAddress", "followingAddress") DO NOTHING
         RETURNING *`,
        [followerAddress, followingAddress],
      );
      if (!inserted.length) {
        throw new ConflictException('Already following this user');
      }
      await em.query(
        `UPDATE users SET
           "followingCount" = "followingCount" + CASE WHEN "walletAddress" = $1 THEN 1 ELSE 0 END,
           "followerCount" = "followerCount" + CASE WHEN "walletAddress" = $2 THEN 1 ELSE 0 END
         WHERE "walletAddress" IN ($1, $2)`,
        [followerAddress, followingAddress],
      );
      return inserted[0];
    });

    await this.invalidateSocialCaches(followerAddress, followingAddress);
    this.eventEmitter.emit('user.followed', {
      followerAddress,
      followingAddress,
    });
    return result;
  }

  async unfollow(followerAddress: string, followingAddress: string) {
    const result = await this.followsRepo.manager.transaction(async (em) => {
      const deleted = affectedRowCount(
        await em.query<unknown>(
          `DELETE FROM follows
           WHERE "followerAddress" = $1 AND "followingAddress" = $2
           RETURNING id`,
          [followerAddress, followingAddress],
        ),
      );
      if (!deleted) {
        throw new BadRequestException('Not following this user');
      }
      await em.query(
        `UPDATE users SET
           "followingCount" = GREATEST("followingCount" - CASE WHEN "walletAddress" = $1 THEN 1 ELSE 0 END, 0),
           "followerCount" = GREATEST("followerCount" - CASE WHEN "walletAddress" = $2 THEN 1 ELSE 0 END, 0)
         WHERE "walletAddress" IN ($1, $2)`,
        [followerAddress, followingAddress],
      );
      return { followerAddress, followingAddress };
    });

    await this.invalidateSocialCaches(followerAddress, followingAddress);
    return result;
  }

  /** Follows if not following, unfollows otherwise. Race-tolerant. */
  async toggleFollow(followerAddress: string, followingAddress: string) {
    const existing = await this.followsRepo.findOne({
      where: { followerAddress, followingAddress },
    });

    let following: boolean;
    try {
      if (existing) {
        await this.unfollow(followerAddress, followingAddress);
        following = false;
      } else {
        await this.follow(followerAddress, followingAddress);
        following = true;
      }
    } catch (err) {
      // A concurrent request already reached the state we were heading for.
      if (existing && err instanceof BadRequestException) following = false;
      else if (!existing && err instanceof ConflictException) following = true;
      else throw err;
    }

    const counts = await this.getFollowCounts(followingAddress);
    return { followerAddress, followingAddress, following, ...counts };
  }

  async getFollowCounts(walletAddress: string) {
    const user = await this.usersRepo.findOne({
      where: { walletAddress },
      select: ['walletAddress', 'followerCount', 'followingCount'],
    });
    return {
      followerCount: user?.followerCount ?? 0,
      followingCount: user?.followingCount ?? 0,
    };
  }

  private async invalidateSocialCaches(
    followerAddress: string,
    followingAddress: string,
  ) {
    await this.invalidateUserProfile(followerAddress);
    await this.invalidateUserProfile(followingAddress);
    await this.socialGraphService.invalidateSecondDegree(followerAddress);
  }

  private async invalidateUserProfile(address: string) {
    const ranges = ['7d', '30d', 'all'];
    for (const range of ranges) {
      await this.cacheManager.del(`profile:${address}:${range}`);
    }
  }

  async getFollowers(address: string, page = 1, limit = 20) {
    const [data, total] = await this.followsRepo.findAndCount({
      where: { followingAddress: address },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { data, total, page, limit };
  }

  async getFollowing(address: string, page = 1, limit = 20) {
    const [data, total] = await this.followsRepo.findAndCount({
      where: { followerAddress: address },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { data, total, page, limit };
  }

  async register(registerDto: RegisterDto) {
    const { referralCode, walletAddress, ...userData } =
      registerDto as RegisterDto & {
        email: string;
        walletAddress: string;
      };

    let referrer: Users | null = null;

    if (referralCode) {
      referrer = await this.usersRepo.findOne({ where: { referralCode } });
      if (!referrer) throw new BadRequestException('Invalid referral code');
    }

    if (referrer && referrer.email === userData.email) {
      throw new BadRequestException('Cannot refer yourself');
    }

    const newUser = this.usersRepo.create({
      ...userData,
      walletAddress,
      referralCode: this.generateReferralCode(),
    });

    if (referrer) newUser.referredBy = referrer;

    const savedUser = await this.usersRepo.save(newUser);
    // Default notification preferences on user creation
    await this.preferenceService
      .initializePreferences(walletAddress)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Failed to initialize notification preferences for ${walletAddress}: ${msg}`,
        );
      });
    this.eventEmitter.emit('user.registered', {
      userId: savedUser.id,
      walletAddress,
    });
    return savedUser;
  }

  async getUserProfile(userId: string) {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    const reliability =
      await this.analyticsService.calculatePredictorReliability(userId);
    return { ...user, predictorReliability: reliability };
  }

  // ─── fetch by wallet address with badges ─────────────────────────────

  async getUserByAddress(walletAddress: string) {
    const user = await this.usersRepo.findOne({
      where: { walletAddress },
      relations: ['badges'],
    });

    if (!user) throw new NotFoundException(`User ${walletAddress} not found`);

    const reliability =
      await this.analyticsService.calculatePredictorReliability(user.id);
    const reputationScore =
      await this.analyticsService.calculateReputationScore(walletAddress);
    // Denormalised counters, kept exact by follow/unfollow transactions.
    const followerCount = user.followerCount ?? 0;
    const followingCount = user.followingCount ?? 0;

    return {
      ...user,
      predictorReliability: reliability,
      reputationScore,
      followerCount,
      followingCount,
      avatarUrl: user.avatarCid ? `ipfs://${user.avatarCid}` : null,
    };
  }

  async createProfile(
    createProfileDto: CreateProfileDto,
    avatarFile?: Express.Multer.File,
  ) {
    let user = await this.usersRepo.findOne({
      where: { walletAddress: createProfileDto.walletAddress },
    });
    if (user) {
      throw new ConflictException('Profile already exists');
    }

    let avatarCid: string | undefined;
    if (avatarFile) {
      avatarCid = await this.ipfsService.pinAvatar(avatarFile);
    }

    user = this.usersRepo.create({
      walletAddress: createProfileDto.walletAddress,
      referralCode: this.generateReferralCode(),
      displayName: createProfileDto.displayName,
      bio: createProfileDto.bio,
      avatarCid,
    });

    await this.usersRepo.save(user);
    return this.getUserByAddress(createProfileDto.walletAddress);
  }

  async updateProfile(
    updateProfileDto: UpdateProfileDto,
    avatarFile?: Express.Multer.File,
  ) {
    const user = await this.usersRepo.findOne({
      where: { walletAddress: updateProfileDto.walletAddress },
    });
    if (!user) {
      throw new NotFoundException(
        `User ${updateProfileDto.walletAddress} not found`,
      );
    }

    if (avatarFile) {
      user.avatarCid = await this.ipfsService.pinAvatar(avatarFile);
    }
    if (updateProfileDto.displayName !== undefined) {
      user.displayName = updateProfileDto.displayName;
    }
    if (updateProfileDto.bio !== undefined) {
      user.bio = updateProfileDto.bio;
    }

    await this.usersRepo.save(user);
    await this.invalidateUserProfile(user.walletAddress);
    return this.getUserByAddress(user.walletAddress);
  }

  async getReferrals(address: string) {
    const user = await this.usersRepo.findOne({
      where: { walletAddress: address },
    });
    if (!user) throw new NotFoundException('User not found');
    const referrals = await this.usersRepo.find({
      where: { referredBy: { id: user.id } },
    });
    return referrals.map((r) => ({
      walletAddress: r.walletAddress,
      displayName: r.displayName,
      createdAt: r.createdAt,
    }));
  }

  async getReferralStats(address: string) {
    const user = await this.usersRepo.findOne({
      where: { walletAddress: address },
    });
    if (!user) throw new NotFoundException('User not found');

    const total = await this.usersRepo.count({
      where: { referredBy: { id: user.id } },
    });

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const query = this.usersRepo
      .createQueryBuilder('user')
      .where('user.referredById = :id', { id: user.id })
      .andWhere('user.createdAt >= :startOfMonth', { startOfMonth });

    const thisMonth = await query.getCount();

    return { total, thisMonth };
  }
}
