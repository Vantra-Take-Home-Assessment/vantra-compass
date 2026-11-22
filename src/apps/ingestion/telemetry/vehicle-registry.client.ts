import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';
import { InjectRedis } from '../../../libs/redis/redis.module';
import { VEHICLE_REGISTRY_KEY } from '../../../libs/contracts';
import { config } from '../../../libs/config';
import { INTERNAL_TOKEN_HEADER } from '../../../libs/auth/guards';

const NEGATIVE_TTL_MS = 60_000;

// vehicleId -> tenantId from the Redis registry, falling back to fleet-api on a miss.
@Injectable()
export class VehicleRegistryClient {
  private readonly logger = new Logger(VehicleRegistryClient.name);
  private readonly unknownUntil = new Map<string, number>();

  constructor(@InjectRedis() private readonly redis: Redis) {}

  /** Returns tenantId, or null if the vehicle is not registered. */
  async resolveTenant(vehicleId: string): Promise<string | null> {
    const cached = await this.redis.hget(VEHICLE_REGISTRY_KEY, vehicleId).catch(() => null);
    if (cached) return cached;

    const negative = this.unknownUntil.get(vehicleId);
    if (negative && negative > Date.now()) return null;

    let res: Response;
    try {
      res = await fetch(`${config.fleetApiUrl()}/internal/vehicles/${encodeURIComponent(vehicleId)}`, {
        headers: { [INTERNAL_TOKEN_HEADER]: config.internalToken() },
        signal: AbortSignal.timeout(3_000),
      });
    } catch (err: any) {
      // 503 so the device retries instead of us guessing a tenant.
      this.logger.warn(`registry lookup for ${vehicleId} failed: ${err.message}`);
      throw new ServiceUnavailableException('Vehicle registry unavailable');
    }
    if (res.status === 404) {
      this.unknownUntil.set(vehicleId, Date.now() + NEGATIVE_TTL_MS);
      if (this.unknownUntil.size > 10_000) this.unknownUntil.clear();
      return null;
    }
    if (!res.ok) throw new ServiceUnavailableException('Vehicle registry unavailable');
    const body = (await res.json()) as { tenantId: string };
    return body.tenantId;
  }
}
