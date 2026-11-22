import { BadRequestException, Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { SWAGGER_INTERNAL } from '../../../libs/swagger';
import { IngestionService } from './ingestion.service';
import { IngestTelemetryDto } from './dto/ingest-telemetry.dto';
import { LastSeenBatchDto } from './dto/last-seen-batch.dto';
import { LatestCacheService } from './latest-cache.service';
import { InternalGuard } from '../../../libs/auth/guards';

// Still unauthenticated: per-device credentials need a firmware rollout.
@ApiTags('ingestion')
@Controller('ingestion')
export class IngestionController {
  constructor(private readonly ingestionService: IngestionService) {}

  @Post('telemetry')
  @ApiOperation({ summary: 'Device GPS telemetry (unauthenticated, see Compass plan, finding F9)' })
  ingest(@Body() dto: IngestTelemetryDto) {
    return this.ingestionService.ingest(dto);
  }
}

@ApiTags('internal')
@ApiSecurity(SWAGGER_INTERNAL)
@Controller('internal')
@UseGuards(InternalGuard)
export class IngestionInternalController {
  constructor(
    private readonly ingestionService: IngestionService,
    private readonly latestCache: LatestCacheService,
  ) {}

  /** fleet-api calls this on a dashboard cache miss. */
  @Get('latest')
  @ApiOperation({ summary: 'Latest reading per vehicle for a tenant (read-through cache)' })
  @ApiQuery({ name: 'tenantId', required: true })
  latest(@Query('tenantId') tenantId: string) {
    if (!tenantId) throw new BadRequestException('tenantId required');
    return this.latestCache.readThroughAndRebuild(tenantId);
  }

  /** alerting confirms offline vehicles here, batched: { [vehicleId]: lastReceivedAt | null }. */
  @Post('vehicles/last-seen')
  @HttpCode(200)
  @ApiOperation({ summary: 'Batch last-received timestamps: { [vehicleId]: ISO | null }' })
  lastSeen(@Body() dto: LastSeenBatchDto) {
    return this.ingestionService.lastSeenMany(dto.vehicleIds);
  }
}
