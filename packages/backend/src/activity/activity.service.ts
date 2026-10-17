import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Activity, ActivityType } from './entities/activity.entity';
import { OnEvent } from '@nestjs/event-emitter';

@Injectable()
export class ActivityService {
  constructor(
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
  ) {}

  async createActivity(
    userAddress: string,
    type: ActivityType,
    metadata: Record<string, unknown>,
  ) {
    const activity = this.activityRepo.create({ userAddress, type, metadata });
    return this.activityRepo.save(activity);
  }

  async getUserActivity(
    userAddress: string,
    page = 1,
    limit = 20,
    type?: ActivityType,
  ) {
    const query = this.activityRepo
      .createQueryBuilder('activity')
      .where('activity.userAddress = :userAddress', { userAddress })
      .orderBy('activity.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (type) {
      query.andWhere('activity.type = :type', { type });
    }

    const [data, total] = await query.getManyAndCount();
    return { data, total, page, limit };
  }

  /**
   * Friend activity feed (BE-034): recent activity from everyone
   * `followerAddress` follows, newest first.
   */
  async getFriendFeed(
    followerAddress: string,
    page = 1,
    limit = 20,
    type?: ActivityType,
  ) {
    const take = Math.min(Math.max(limit, 1), 100);
    const skip = (Math.max(page, 1) - 1) * take;
    const query = this.activityRepo
      .createQueryBuilder('activity')
      .innerJoin(
        'follows',
        'f',
        'f."followingAddress" = activity."userAddress" AND f."followerAddress" = :followerAddress',
        { followerAddress },
      )
      .orderBy('activity.createdAt', 'DESC')
      .addOrderBy('activity.id', 'DESC')
      .skip(skip)
      .take(take);

    if (type) {
      query.andWhere('activity.type = :type', { type });
    }

    const [data, total] = await query.getManyAndCount();
    return { data, total, page: Math.max(page, 1), limit: take };
  }

  @OnEvent('call.created')
  async handleCallCreated(payload: {
    id: string;
    creatorAddress: string;
    title: string;
  }): Promise<void> {
    await this.createActivity(
      payload.creatorAddress,
      ActivityType.CALL_CREATED,
      { callId: payload.id, title: payload.title },
    );
  }

  @OnEvent('stake.created')
  async handleStakePlaced(payload: {
    userAddress: string;
    callId: string;
    amount: number;
  }): Promise<void> {
    await this.createActivity(payload.userAddress, ActivityType.STAKE_PLACED, {
      callId: payload.callId,
      amount: payload.amount,
    });
  }

  @OnEvent('payout.claimed')
  async handlePayoutClaimed(payload: {
    userAddress: string;
    callId: string;
    amount: number;
  }): Promise<void> {
    await this.createActivity(
      payload.userAddress,
      ActivityType.PAYOUT_CLAIMED,
      { callId: payload.callId, amount: payload.amount },
    );
  }

  @OnEvent('user.followed')
  async handleNewFollower(payload: {
    followingAddress: string;
    followerAddress: string;
  }): Promise<void> {
    await this.createActivity(
      payload.followingAddress,
      ActivityType.NEW_FOLLOWER,
      { followerAddress: payload.followerAddress },
    );
  }
}
