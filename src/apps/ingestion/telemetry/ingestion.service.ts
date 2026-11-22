import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import Redis from 'ioredis';
import { TelemetryEvent, TelemetryEventDocument } from './schemas/telemetry-event.schema';
import { VehicleLatest, VehicleLatestDocument } from './schemas/vehicle-latest.schema';
import { IngestTelemetryDto } from './dto/ingest-telemetry.dto';
import { isNotFuture, isPlausibleCoordinate } from './ingestion.validators';
import { VehicleRegistryClient } from './vehicle-registry.client';
import { LatestCacheService, toLatestReading } from './latest-cache.service';
import { InjectRedis } from '../../../libs/redis/redis.module';
import { TELEMETRY_STREAM, TelemetryReceivedEvent, normalizeBatteryPct } from '../../../libs/contracts';

const STREAM_MAXLEN = 1_000_000;

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    @InjectModel(TelemetryEvent.name) private telemetryModel: Model<TelemetryEventDocument>,
    @InjectModel(VehicleLatest.name) private latestModel: Model<VehicleLatestDocument>,
    private readonly registry: VehicleRegistryClient,
    private readonly latestCache: LatestCacheService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  /**
   * Raw event first (must succeed), then projection, cache and stream publish.
   * The later steps are best effort and safe to replay, since devices retry.
   */
  async ingest(dto: IngestTelemetryDto) {
    if (!isPlausibleCoordinate(dto.lat, dto.lng)) {
      throw new BadRequestException('Coordinates out of range');
    }
    if (!isNotFuture(dto.recordedAt)) {
      throw new BadRequestException('recordedAt cannot be in the future');
    }

    const tenantId = await this.registry.resolveTenant(dto.vehicleId);
    const event = await this.telemetryModel.create({
      tenantId,
      vehicleId: dto.vehicleId,
      recordedAt: new Date(dto.recordedAt),
      location: { lat: dto.lat, lng: dto.lng },
    });

    if (!tenantId) {
      // Unregistered vehicle: keep the data, but no tenant sees it.
      this.logger.warn(`quarantined telemetry for unregistered vehicle ${dto.vehicleId}`);
      return event;
    }

    await this.advanceProjection(tenantId, event);
    return event;
  }

  private async advanceProjection(tenantId: string, event: TelemetryEventDocument) {
    const receivedAt = event.receivedAt as Date;

    // Liveness only ever moves forward ($max), whatever order events arrive in.
    await this.latestModel
      .updateOne(
        { vehicleId: event.vehicleId },
        { $max: { lastReceivedAt: receivedAt }, $setOnInsert: { tenantId } },
        { upsert: true },
      )
      .exec();

    // Only a strictly newer recordedAt replaces the latest reading.
    const snapshot = {
      eventId: event._id.toString(),
      recordedAt: event.recordedAt,
      receivedAt,
      location: { lat: event.location.lat, lng: event.location.lng },
      batteryLevel: event.batteryLevel,
      batteryPct: normalizeBatteryPct(event.batteryLevel),
    };
    const res = await this.latestModel
      .updateOne(
        {
          vehicleId: event.vehicleId,
          $or: [{ recordedAt: { $lt: event.recordedAt } }, { recordedAt: { $exists: false } }],
        },
        { $set: snapshot },
      )
      .exec();

    if (res.modifiedCount === 1) {
      await this.latestCache.merge(
        tenantId,
        toLatestReading({ vehicleId: event.vehicleId, tenantId, lastReceivedAt: receivedAt, ...snapshot }),
      );
    }

    const payload: TelemetryReceivedEvent = {
      eventId: event._id.toString(),
      tenantId,
      vehicleId: event.vehicleId,
      recordedAt: event.recordedAt.toISOString(),
      receivedAt: receivedAt.toISOString(),
    };
    await this.redis
      .xadd(TELEMETRY_STREAM, 'MAXLEN', '~', STREAM_MAXLEN, '*', 'data', JSON.stringify(payload))
      .catch((err) => this.logger.error(`failed to publish telemetry event ${payload.eventId}: ${err.message}`));
  }

  /** One indexed $in query (vehicle_latest.vehicleId is unique). */
  async lastSeenMany(vehicleIds: string[]): Promise<Record<string, Date | null>> {
    const out: Record<string, Date | null> = Object.fromEntries(vehicleIds.map((id) => [id, null]));
    if (vehicleIds.length === 0) return out;
    const docs = await this.latestModel
      .find({ vehicleId: { $in: vehicleIds } }, { _id: 0, vehicleId: 1, lastReceivedAt: 1 })
      .lean()
      .exec();
    for (const d of docs) out[d.vehicleId] = d.lastReceivedAt ?? null;
    return out;
  }
}
