// Runs against real Redis and Mongo (npm run test:int).
import mongoose, { Connection, Model } from 'mongoose';
import Redis from 'ioredis';
import { LatestCacheService } from './latest-cache.service';
import { VehicleLatest, VehicleLatestSchema } from './schemas/vehicle-latest.schema';
import { LATEST_READY_FIELD, LatestReading, latestKey } from '../../../libs/contracts';

const MONGO = process.env.MONGO_URI_TEST || 'mongodb://localhost:27017';
const REDIS = process.env.REDIS_URL_TEST || 'redis://localhost:6379/15';
const T = 'tenant-int';

const reading = (vehicleId: string, recordedAt: Date, lat = 1): LatestReading => ({
  _id: `e-${recordedAt.getTime()}`,
  vehicleId,
  recordedAt: recordedAt.toISOString(),
  receivedAt: new Date().toISOString(),
  location: { lat, lng: 1 },
  batteryPct: null,
});

describe('LatestCacheService (real Redis + Mongo)', () => {
  let conn: Connection;
  let redis: Redis;
  let latest: Model<any>;
  let cache: LatestCacheService;

  const cached = async (vehicleId: string) => {
    const v = await redis.hget(latestKey(T), vehicleId);
    return v ? JSON.parse(v.slice(v.indexOf('|') + 1)) : null;
  };

  beforeAll(async () => {
    conn = await mongoose.createConnection(`${MONGO}/vantra_int_cache_${Date.now()}`).asPromise();
    latest = conn.model(VehicleLatest.name, VehicleLatestSchema);
    redis = new Redis(REDIS);
    cache = new LatestCacheService(redis, latest as any);
  });
  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
    await redis.flushdb();
    redis.disconnect();
  });
  beforeEach(async () => {
    await redis.flushdb();
    await latest.deleteMany({});
  });

  it('does not write into a cold hash (would look complete with only a few vehicles)', async () => {
    expect(await cache.merge(T, reading('v1', new Date()))).toBe(-1);
    expect(await redis.exists(latestKey(T))).toBe(0);
  });

  it('rebuilds from the projection, then merges monotonically', async () => {
    const t0 = new Date(Date.now() - 60_000);
    await latest.create({ vehicleId: 'v1', tenantId: T, lastReceivedAt: t0, recordedAt: t0, eventId: 'a' });
    const out = await cache.readThroughAndRebuild(T);
    expect(Object.keys(out)).toEqual(['v1']);
    expect(await redis.hexists(latestKey(T), LATEST_READY_FIELD)).toBe(1);

    const newer = new Date();
    expect(await cache.merge(T, reading('v1', newer, 2))).toBe(1);
    expect(await cache.merge(T, reading('v1', t0, 3))).toBe(0); // delayed/out-of-order
    expect(await cache.merge(T, reading('v1', newer, 4))).toBe(0); // duplicate
    expect((await cached('v1')).location.lat).toBe(2);
  });

  it('a live write racing a rebuild is never lost or overwritten by older rebuild data', async () => {
    const old = new Date(Date.now() - 3_600_000);
    for (let i = 0; i < 3000; i++) {
      await latest.collection.insertOne({ vehicleId: `v${i}`, tenantId: T, lastReceivedAt: old, recordedAt: old, eventId: `old${i}` });
    }
    const fresh = new Date();
    const rebuild = cache.readThroughAndRebuild(T);
    // fire live writes while the rebuild is streaming
    await new Promise((r) => setTimeout(r, 5));
    const live = await Promise.all([0, 1500, 2999].map((i) => cache.merge(T, reading(`v${i}`, fresh, 9))));
    await rebuild;
    for (const i of [0, 1500, 2999]) {
      expect((await cached(`v${i}`)).location.lat).toBe(9);
    }
    expect(live.every((r) => r === 1)).toBe(true);
    expect(await redis.hlen(latestKey(T))).toBe(3001); // 3000 vehicles + __ready
  });

  it('a hash evicted mid-rebuild is not resurrected as "ready" with partial data', async () => {
    const t0 = new Date();
    await latest.create({ vehicleId: 'v1', tenantId: T, lastReceivedAt: t0, recordedAt: t0, eventId: 'a' });
    // Simulate eviction between __building and finalize by deleting on first merge.
    const origPipeline = redis.pipeline.bind(redis);
    let once = false;
    (redis as any).pipeline = () => {
      const p = origPipeline();
      const exec = p.exec.bind(p);
      p.exec = async () => {
        if (!once) {
          once = true;
          await redis.del(latestKey(T));
        }
        return exec();
      };
      return p;
    };
    await cache.readThroughAndRebuild(T);
    (redis as any).pipeline = origPipeline;
    expect(await redis.hexists(latestKey(T), LATEST_READY_FIELD)).toBe(0);
  });
});
