import { ConflictException, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import Redis from 'ioredis';
import { Vehicle, VehicleDocument } from './schemas/vehicle.schema';
import { InjectRedis } from '../../../libs/redis/redis.module';
import { VEHICLE_REGISTRY_KEY, tenantVehiclesKey } from '../../../libs/contracts';

const TENANT_VEHICLES_TTL_SECONDS = 60;

// tenantId always comes from the caller's JWT, never from the request.
@Injectable()
export class VehiclesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(VehiclesService.name);

  constructor(
    @InjectModel(Vehicle.name) private vehicleModel: Model<VehicleDocument>,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  /** Cache-aside, invalidated on create; the TTL only covers writes made outside this service. */
  async findAll(tenantId: string): Promise<Record<string, unknown>[]> {
    const key = tenantVehiclesKey(tenantId);
    const cached = await this.redis.get(key).catch(() => null);
    if (cached) return JSON.parse(cached);
    const vehicles = await this.vehicleModel.find({ tenantId }).sort({ vehicleId: 1 }).lean().exec();
    await this.redis
      .set(key, JSON.stringify(vehicles), 'EX', TENANT_VEHICLES_TTL_SECONDS)
      .catch((err) => this.logger.warn(`vehicle list cache write failed: ${err.message}`));
    return vehicles as unknown as Record<string, unknown>[];
  }

  async findByVehicleId(tenantId: string, vehicleId: string) {
    // Same 404 for missing and other-tenant, so ids can't be probed.
    const vehicle = await this.vehicleModel.findOne({ tenantId, vehicleId }).lean().exec();
    if (!vehicle) throw new NotFoundException();
    return vehicle;
  }

  async create(tenantId: string, vehicleId: string, fleetName: string) {
    let vehicle: VehicleDocument;
    try {
      vehicle = await this.vehicleModel.create({ tenantId, vehicleId, fleetName });
    } catch (err: any) {
      if (err?.code === 11000) throw new ConflictException('vehicleId already registered');
      throw err;
    }
    // If the registry write fails, ingestion falls back to /internal/vehicles/:id.
    await this.redis.hset(VEHICLE_REGISTRY_KEY, vehicleId, tenantId).catch(() => undefined);
    await this.redis.del(tenantVehiclesKey(tenantId)).catch(() => undefined);
    return vehicle;
  }

  /** Unscoped lookup for service-to-service use only (InternalGuard). */
  findForRegistry(vehicleId: string) {
    return this.vehicleModel.findOne({ vehicleId }, { vehicleId: 1, tenantId: 1, status: 1 }).lean().exec();
  }

  /** Republishes the vehicle registry on startup, so a flushed Redis recovers. */
  async onApplicationBootstrap() {
    let count = 0;
    let pipeline = this.redis.pipeline();
    const cursor = this.vehicleModel
      .find({ tenantId: { $exists: true } }, { vehicleId: 1, tenantId: 1 })
      .lean()
      .cursor();
    for await (const v of cursor) {
      pipeline.hset(VEHICLE_REGISTRY_KEY, v.vehicleId, v.tenantId as string);
      if (++count % 1000 === 0) {
        await pipeline.exec();
        pipeline = this.redis.pipeline();
      }
    }
    await pipeline.exec();
    this.logger.log(`published ${count} vehicles to the registry`);
  }
}
