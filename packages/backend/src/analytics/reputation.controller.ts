import {
  Controller,
  Get,
  HttpStatus,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ReputationDecayService } from './reputation-decay.service';

@ApiTags('Analytics')
@Controller('analytics')
export class ReputationController {
  constructor(private readonly reputationService: ReputationDecayService) {}

  @Get('expertise/:address')
  @ApiOperation({
    summary: 'Decayed reputation and category expertise tiers for a predictor',
  })
  @ApiParam({ name: 'address', description: 'Stellar wallet address' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Expertise returned' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Not indexed yet' })
  async getCategoryExpertise(@Param('address') address: string) {
    const expertise =
      await this.reputationService.getCategoryExpertise(address);
    if (!expertise) {
      throw new NotFoundException(`No reputation indexed for ${address}`);
    }
    return expertise;
  }
}
