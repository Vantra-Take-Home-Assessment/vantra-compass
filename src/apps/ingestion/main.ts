import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { IngestionController, IngestionInternalController } from './telemetry/ingestion.controller';
import { IngestionService } from './telemetry/ingestion.service';
import { LatestCacheService } from './telemetry/latest-cache.service';
import { VehicleRegistryClient } from './telemetry/vehicle-registry.client';
import { TelemetryEvent, TelemetryEventSchema } from './telemetry/schemas/telemetry-event.schema';
import { VehicleLatest, VehicleLatestSchema } from './telemetry/schemas/vehicle-latest.schema';
import { RedisModule } from '../../libs/redis/redis.module';
import { AuthLibModule } from '../../libs/auth/auth-lib.module';
import { HealthController, bootstrapService } from '../../libs/bootstrap';
import { config } from '../../libs/config';

// Owns telemetryevents, vehicle_latest, the latest:{tenant} cache and the telemetry stream.
@Module({
  imports: [
    MongooseModule.forRoot(config.mongoUri()),
    MongooseModule.forFeature([
      { name: TelemetryEvent.name, schema: TelemetryEventSchema },
      { name: VehicleLatest.name, schema: VehicleLatestSchema },
    ]),
    RedisModule,
    AuthLibModule,
  ],
  controllers: [IngestionController, IngestionInternalController, HealthController],
  providers: [IngestionService, LatestCacheService, VehicleRegistryClient],
})
export class IngestionAppModule {}

if (require.main === module) {
  bootstrapService('ingestion', IngestionAppModule, 3002);
}
