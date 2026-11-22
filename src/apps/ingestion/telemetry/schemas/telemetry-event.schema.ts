import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

// _id: false, otherwise Mongoose adds an _id to every location in API responses.
const LocationSchema = new MongooseSchema({ lat: Number, lng: Number }, { _id: false });

export type TelemetryEventDocument = TelemetryEvent & Document;

// Raw, append-only telemetry: never rewritten after insert.
@Schema({ timestamps: { createdAt: 'receivedAt', updatedAt: false } })
export class TelemetryEvent {
  @Prop({ required: true })
  vehicleId: string;

  // null = quarantined (unregistered vehicle): stored but never projected or alerted on.
  @Prop({ type: String, default: null })
  tenantId: string | null;

  // Device clock. Used for ordering readings, never for liveness.
  @Prop({ required: true })
  recordedAt: Date;

  // Server clock. Populated by the timestamps option above.
  receivedAt?: Date;

  // Required for new writes; ~0.5% of historical docs lack it.
  @Prop({ type: LocationSchema, required: true })
  location: { lat: number; lng: number };

  // Mixed: "87%" (old firmware) or numeric (new firmware). See VANTRA-512 and
  // normalizeBatteryPct() in libs/contracts.ts.
  @Prop({ type: Object, required: false })
  batteryLevel?: string | number;

  // Reserved, VANTRA-538. Not accepted by ingestion yet.
  @Prop({ type: Object, required: false })
  engineDiagnostics?: Record<string, unknown>;
}

export const TelemetryEventSchema = SchemaFactory.createForClass(TelemetryEvent);
TelemetryEventSchema.index({ vehicleId: 1, recordedAt: -1 });
