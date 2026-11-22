import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { InternalVehiclesController, VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';
import { Vehicle, VehicleSchema } from './schemas/vehicle.schema';
import { AuthLibModule } from '../../../libs/auth/auth-lib.module';

@Module({
  imports: [AuthLibModule, MongooseModule.forFeature([{ name: Vehicle.name, schema: VehicleSchema }])],
  controllers: [VehiclesController, InternalVehiclesController],
  providers: [VehiclesService],
  exports: [VehiclesService],
})
export class VehiclesModule {}
