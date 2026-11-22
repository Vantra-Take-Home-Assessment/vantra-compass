import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString } from 'class-validator';
import { LAST_SEEN_BATCH_MAX } from '../../../../libs/contracts';

export class LastSeenBatchDto {
  @ApiProperty({ type: [String], maxItems: LAST_SEEN_BATCH_MAX, example: ['TRUCK-001', 'TRUCK-002'] })
  @IsArray()
  @ArrayMaxSize(LAST_SEEN_BATCH_MAX)
  @IsString({ each: true })
  vehicleIds: string[];
}
