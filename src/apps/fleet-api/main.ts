import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from './auth/auth.module';
import { VehiclesModule } from './vehicles/vehicles.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { RedisModule } from '../../libs/redis/redis.module';
import { HealthController, bootstrapService } from '../../libs/bootstrap';
import { config } from '../../libs/config';

// Owns users, tenants and vehicles; serves auth and dashboard reads.
@Module({
  imports: [MongooseModule.forRoot(config.mongoUri()), RedisModule, AuthModule, VehiclesModule, DashboardModule],
  controllers: [HealthController],
})
export class FleetApiModule {}

if (require.main === module) {
  bootstrapService('fleet-api', FleetApiModule, 3001);
}
