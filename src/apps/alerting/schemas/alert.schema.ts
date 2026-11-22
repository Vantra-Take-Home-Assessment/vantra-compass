import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AlertDocument = Alert & Document<Types.ObjectId>;

export type DeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'legacy';

// Outbox state lives on the alert, so creating and queueing it is one write.
@Schema({ _id: false })
export class Delivery {
  @Prop({ required: true }) status: DeliveryStatus;
  @Prop({ default: 0 }) attempts: number;
  @Prop({ type: Date, default: null }) nextAttemptAt: Date | null;
  @Prop({ type: Date, default: null }) lockedUntil: Date | null;
  @Prop({ type: Date, default: null }) sentAt: Date | null;
  @Prop({ type: String, default: null }) lastError: string | null;
}
const DeliverySchema = SchemaFactory.createForClass(Delivery);

@Schema({ timestamps: true })
export class Alert {
  @Prop({ required: true, index: true })
  vehicleId: string;

  @Prop({ index: true })
  tenantId?: string;

  @Prop({ required: true })
  type: string;

  @Prop({ required: true })
  message: string;

  @Prop({ default: 'open' })
  status: 'open' | 'resolved';

  // Kept for API compatibility (clients filter on it).
  @Prop({ type: Date, default: null })
  resolvedAt: Date | null;

  /** 'auto:telemetry' or the email of the user who resolved it (audit trail). */
  @Prop({ type: String, default: null })
  resolvedBy: string | null;

  /** The lastSeenAt this alert was raised against (identifies the offline episode). */
  @Prop({ type: Date, default: null })
  offlineSince: Date | null;

  @Prop({ type: DeliverySchema })
  delivery?: Delivery;
}

export const AlertSchema = SchemaFactory.createForClass(Alert);
// At most one open alert of a type per vehicle.
AlertSchema.index(
  { vehicleId: 1, type: 1 },
  { unique: true, partialFilterExpression: { status: 'open' }, name: 'one_open_alert_per_vehicle_type' },
);
AlertSchema.index({ 'delivery.status': 1, 'delivery.nextAttemptAt': 1 });
