import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type VehicleStateDocument = VehicleState & Document;

// Alerting's own view of each vehicle, built from telemetry.received events.
@Schema({ collection: 'alerting_vehicle_state', versionKey: false })
export class VehicleState {
  @Prop({ required: true, unique: true })
  vehicleId: string;

  @Prop({ required: true, index: true })
  tenantId: string;

  /** max(receivedAt): server clock, so device clock drift can't affect it. */
  @Prop({ type: Date, required: true })
  lastSeenAt: Date;

  @Prop({ type: Types.ObjectId, default: null })
  openOfflineAlertId: Types.ObjectId | null;

  /** lastSeenAt at the moment the open alert was raised. */
  @Prop({ type: Date, default: null })
  offlineSince: Date | null;

  /** False between claiming an alert id and inserting the alert doc (crash window). */
  @Prop({ default: true })
  alertMaterialized: boolean;

  /** lastSeenAt of the episode a human resolved; the sweep won't re-raise it. */
  @Prop({ type: Date, default: null })
  acknowledgedLastSeenAt: Date | null;
}

export const VehicleStateSchema = SchemaFactory.createForClass(VehicleState);
VehicleStateSchema.index({ openOfflineAlertId: 1, lastSeenAt: 1 });
