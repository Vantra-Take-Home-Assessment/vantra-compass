import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import Redis from 'ioredis';
import { InjectRedis } from '../../../libs/redis/redis.module';
import {
  LATEST_BUILDING_FIELD,
  LATEST_READY_FIELD,
  LatestReading,
  latestKey,
} from '../../../libs/contracts';
import { VehicleLatest, VehicleLatestDocument } from './schemas/vehicle-latest.schema';

// Only a newer reading wins, and only into a __ready or __building hash.
// Returns 1 = written, 0 = stale, -1 = hash not live.
const MERGE_LUA = `
if redis.call('HEXISTS', KEYS[1], '${LATEST_READY_FIELD}') == 0
   and redis.call('HEXISTS', KEYS[1], '${LATEST_BUILDING_FIELD}') == 0 then
  return -1
end
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if cur then
  local sep = string.find(cur, '|', 1, true)
  if sep and tonumber(string.sub(cur, 1, sep - 1)) >= tonumber(ARGV[2]) then
    return 0
  end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2] .. '|' .. ARGV[3])
return 1
`;

// Marks ready only if still building, so a hash evicted mid-rebuild can't come back partial.
const FINALIZE_LUA = `
if redis.call('HEXISTS', KEYS[1], '${LATEST_BUILDING_FIELD}') == 1 then
  redis.call('HSET', KEYS[1], '${LATEST_READY_FIELD}', ARGV[1])
  redis.call('HDEL', KEYS[1], '${LATEST_BUILDING_FIELD}')
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
`;

const HASH_TTL_SECONDS = 3600;
const REBUILD_LOCK_MS = 30_000;

@Injectable()
export class LatestCacheService {
  private readonly logger = new Logger(LatestCacheService.name);

  constructor(
    @InjectRedis() private readonly redis: Redis,
    @InjectModel(VehicleLatest.name) private readonly latestModel: Model<VehicleLatestDocument>,
  ) {
    this.redis.defineCommand('vantraLatestMerge', { numberOfKeys: 1, lua: MERGE_LUA });
    this.redis.defineCommand('vantraLatestFinalize', { numberOfKeys: 1, lua: FINALIZE_LUA });
  }

  async merge(tenantId: string, reading: LatestReading): Promise<number> {
    try {
      return await (this.redis as any).vantraLatestMerge(
        latestKey(tenantId),
        reading.vehicleId,
        String(new Date(reading.recordedAt).getTime()),
        JSON.stringify(reading),
      );
    } catch (err: any) {
      this.logger.warn(`latest cache merge failed for ${reading.vehicleId}: ${err.message}`);
      // Don't leave a hash marked complete that missed a write; the TTL covers it if this fails too.
      await this.redis.hdel(latestKey(tenantId), LATEST_READY_FIELD).catch(() => undefined);
      return -1;
    }
  }

  /** Cache miss: returns the Mongo map and rebuilds the hash (building -> merge -> ready). */
  async readThroughAndRebuild(tenantId: string): Promise<Record<string, LatestReading>> {
    const key = latestKey(tenantId);
    const lock = await this.redis
      .set(`lock:rebuild:${key}`, '1', 'PX', REBUILD_LOCK_MS, 'NX')
      .catch(() => null);
    if (lock) {
      await this.redis.hset(key, LATEST_BUILDING_FIELD, Date.now().toString()).catch(() => undefined);
    }

    const out: Record<string, LatestReading> = {};
    let pipeline = lock ? this.redis.pipeline() : null;
    let n = 0;
    const cursor = this.latestModel.find({ tenantId, recordedAt: { $exists: true } }).lean().cursor();
    for await (const doc of cursor) {
      const reading = toLatestReading(doc as VehicleLatest);
      out[reading.vehicleId] = reading;
      if (pipeline) {
        (pipeline as any).vantraLatestMerge(
          key,
          reading.vehicleId,
          String(new Date(reading.recordedAt).getTime()),
          JSON.stringify(reading),
        );
        if (++n % 1000 === 0) {
          await pipeline.exec();
          pipeline = this.redis.pipeline();
        }
      }
    }
    if (pipeline) {
      try {
        await pipeline.exec();
        await (this.redis as any).vantraLatestFinalize(key, Date.now().toString(), String(HASH_TTL_SECONDS));
        this.logger.log(`rebuilt ${key} with ${Object.keys(out).length} vehicles`);
      } catch (err: any) {
        this.logger.warn(`rebuild of ${key} failed: ${err.message}`);
      } finally {
        await this.redis.del(`lock:rebuild:${key}`).catch(() => undefined);
      }
    }
    return out;
  }
}

export function toLatestReading(doc: VehicleLatest): LatestReading {
  return {
    _id: doc.eventId as string,
    vehicleId: doc.vehicleId,
    recordedAt: new Date(doc.recordedAt as Date).toISOString(),
    receivedAt: new Date((doc.receivedAt ?? doc.lastReceivedAt) as Date).toISOString(),
    ...(doc.location ? { location: doc.location } : {}),
    ...(doc.batteryLevel !== undefined && doc.batteryLevel !== null ? { batteryLevel: doc.batteryLevel } : {}),
    batteryPct: doc.batteryPct ?? null,
  };
}
