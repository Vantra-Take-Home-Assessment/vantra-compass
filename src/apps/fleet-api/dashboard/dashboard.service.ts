import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';
import { VehiclesService } from '../vehicles/vehicles.service';
import { InjectRedis } from '../../../libs/redis/redis.module';
import { LATEST_READY_FIELD, LatestReading, latestKey } from '../../../libs/contracts';
import { config } from '../../../libs/config';
import { INTERNAL_TOKEN_HEADER } from '../../../libs/auth/guards';

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly vehiclesService: VehiclesService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  getFleetOverview(tenantId: string) {
    return this.vehiclesService.findAll(tenantId);
  }

  /** Vehicle list + one HGETALL of the ingestion-owned hash; on a miss, ingestion rebuilds it. */
  async getVehicleStatuses(tenantId: string) {
    const [vehicles, latest] = await Promise.all([
      this.vehiclesService.findAll(tenantId),
      this.getLatestByVehicle(tenantId),
    ]);
    return vehicles.map((vehicle) => ({
      vehicle,
      latest: latest[vehicle.vehicleId as string] ?? null,
    }));
  }

  private async getLatestByVehicle(tenantId: string): Promise<Record<string, LatestReading>> {
    let hash: Record<string, string> = {};
    try {
      hash = await this.redis.hgetall(latestKey(tenantId));
    } catch (err: any) {
      this.logger.warn(`latest cache read failed, falling back to ingestion: ${err.message}`);
    }
    if (hash[LATEST_READY_FIELD]) {
      const out: Record<string, LatestReading> = {};
      for (const [field, value] of Object.entries(hash)) {
        // Stored as "<recordedAtMs>|<json>" (see ingestion LatestCacheService).
        if (!field.startsWith('__')) out[field] = JSON.parse(value.slice(value.indexOf('|') + 1));
      }
      return out;
    }
    return this.fetchFromIngestion(tenantId);
  }

  private async fetchFromIngestion(tenantId: string): Promise<Record<string, LatestReading>> {
    const res = await fetch(
      `${config.ingestionUrl()}/internal/latest?tenantId=${encodeURIComponent(tenantId)}`,
      { headers: { [INTERNAL_TOKEN_HEADER]: config.internalToken() }, signal: AbortSignal.timeout(10_000) },
    ).catch((err) => {
      this.logger.error(`ingestion unreachable: ${err.message}`);
      return null;
    });
    if (!res || !res.ok) {
      throw new ServiceUnavailableException('Latest vehicle readings temporarily unavailable');
    }
    return res.json() as Promise<Record<string, LatestReading>>;
  }
}
