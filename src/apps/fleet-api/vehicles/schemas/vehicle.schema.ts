import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type VehicleDocument = Vehicle & Document;

@Schema({ timestamps: true })
export class Vehicle {
  // Globally unique: ingestion resolves the tenant from it.
  @Prop({ required: true, unique: true })
  vehicleId: string;

  @Prop({ required: true })
  fleetName: string;

  // Backfilled from fleetName by scripts/migrate-compass.ts.
  @Prop({ index: true })
  tenantId?: string;

  @Prop({ default: 'active' })
  status: string;
}

export const VehicleSchema = SchemaFactory.createForClass(Vehicle);
