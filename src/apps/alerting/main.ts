import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { AlertingController } from './alerting.controller';
import { RecalibrateController } from './admin/recalibrate.controller';
import { AlertStateService } from './alert-state.service';
import { LastSeenVerifier } from './last-seen.verifier';
import { TelemetryConsumer } from './telemetry.consumer';
import { AlertingJobs } from './alerting.jobs';
import { AlertDispatcher } from './delivery/alert-dispatcher';
import { Notifier } from './delivery/notifier';
import { Alert, AlertSchema } from './schemas/alert.schema';
import { VehicleState, VehicleStateSchema } from './schemas/vehicle-state.schema';
import { RedisModule } from '../../libs/redis/redis.module';
import { AuthLibModule } from '../../libs/auth/auth-lib.module';
import { HealthController, bootstrapService } from '../../libs/bootstrap';
import { config } from '../../libs/config';

// Owns alerts and alerting_vehicle_state; learns about telemetry only via the stream and ingestion's API.
@Module({
  imports: [
    MongooseModule.forRoot(config.mongoUri()),
    MongooseModule.forFeature([
      { name: Alert.name, schema: AlertSchema },
      { name: VehicleState.name, schema: VehicleStateSchema },
    ]),
    ScheduleModule.forRoot(),
    RedisModule,
    AuthLibModule,
  ],
  controllers: [AlertingController, RecalibrateController, HealthController],
  providers: [AlertStateService, LastSeenVerifier, TelemetryConsumer, AlertingJobs, AlertDispatcher, Notifier],
})
export class AlertingAppModule {}

if (require.main === module) {
  bootstrapService('alerting', AlertingAppModule, 3003);
}
