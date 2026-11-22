import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type VehicleLatestDocument = VehicleLatest & Document;

// Newest reading and newest arrival per vehicle; the source the Redis cache is rebuilt from.
@Schema({ collection: 'vehicle_latest', versionKey: false })
export class VehicleLatest {
  @Prop({ required: true, unique: true })
  vehicleId: string;

  @Prop({ required: true, index: true })
  tenantId: string;

  /** Liveness: max(receivedAt) over every event, in any order. */
  @Prop({ type: Date })
  lastReceivedAt: Date;

  // Snapshot of the reading with the greatest recordedAt seen so far.
  @Prop() eventId?: string;
  @Prop({ type: Date }) recordedAt?: Date;
  @Prop({ type: Date }) receivedAt?: Date;
  @Prop({ type: Object }) location?: { lat: number; lng: number };
  @Prop({ type: Object }) batteryLevel?: string | number;
  @Prop({ type: Number, default: null }) batteryPct?: number | null;
}

export const VehicleLatestSchema = SchemaFactory.createForClass(VehicleLatest);
