import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { hostname } from 'os';
import { InjectRedis } from '../../libs/redis/redis.module';
import { ALERTING_CONSUMER_GROUP, TELEMETRY_STREAM, TelemetryReceivedEvent } from '../../libs/contracts';
import { AlertStateService } from './alert-state.service';

type StreamEntry = [id: string, fields: string[]];

const READ_COUNT = 500;
const APPLY_CONCURRENCY = 50; // well under the Mongo driver's default pool of 100

/** At-least-once consumer: XACK after apply; a crashed replica's entries are reclaimed. */
@Injectable()
export class TelemetryConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TelemetryConsumer.name);
  private readonly consumer = `${hostname()}-${process.pid}`;
  private reader: Redis;
  private running = false;
  private loop?: Promise<void>;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly alertState: AlertStateService,
  ) {}

  async onApplicationBootstrap() {
    // Blocking XREADGROUP needs its own connection.
    this.reader = this.redis.duplicate();
    try {
      await this.redis.xgroup('CREATE', TELEMETRY_STREAM, ALERTING_CONSUMER_GROUP, '$', 'MKSTREAM');
    } catch (err: any) {
      if (!String(err.message).includes('BUSYGROUP')) throw err;
    }
    this.running = true;
    this.loop = this.run();
  }

  async onApplicationShutdown() {
    this.running = false;
    this.reader?.disconnect();
    await this.loop?.catch(() => undefined);
  }

  private async run() {
    // Our own un-acked entries from a previous life first, then new ones.
    let cursor = '0';
    let lastReclaim = 0;
    while (this.running) {
      try {
        if (Date.now() - lastReclaim > 30_000) {
          lastReclaim = Date.now(); // before, so a failing reclaim doesn't run every iteration
          await this.reclaimAbandoned();
        }
        const res = (await this.reader.xreadgroup(
          'GROUP', ALERTING_CONSUMER_GROUP, this.consumer,
          'COUNT', READ_COUNT, 'BLOCK', 5000,
          'STREAMS', TELEMETRY_STREAM, cursor,
        )) as [string, StreamEntry[]][] | null;
        const entries = res?.[0]?.[1] ?? [];
        if (cursor !== '>') {
          // Advance even if some fail, so one bad entry can't pin the consumer.
          cursor = entries.length === 0 ? '>' : entries[entries.length - 1][0];
        }
        await this.handle(entries);
      } catch (err: any) {
        if (!this.running) return;
        this.logger.error(`consumer loop error: ${err.message}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private async reclaimAbandoned() {
    const [, entries] = (await this.redis.xautoclaim(
      TELEMETRY_STREAM, ALERTING_CONSUMER_GROUP, this.consumer, 60_000, '0-0', 'COUNT', 500,
    )) as [string, StreamEntry[]];
    if (entries.length) this.logger.warn(`reclaimed ${entries.length} abandoned telemetry events`);
    await this.handle(entries.filter((e) => e && e[1]));
  }

  /**
   * Only the newest receivedAt per vehicle matters ($max), so the batch is
   * coalesced and applied in parallel. Only successful entries are acked.
   */
  private async handle(entries: StreamEntry[]) {
    if (entries.length === 0) return;
    const perVehicle = new Map<string, { tenantId: string; receivedAt: Date; ids: string[] }>();
    const ackable: string[] = [];

    for (const [id, fields] of entries) {
      let evt: TelemetryReceivedEvent | null = null;
      try {
        evt = JSON.parse(fields[fields.indexOf('data') + 1]);
      } catch {
        this.logger.error(`dropping unparseable stream entry ${id}`);
      }
      if (!evt) {
        ackable.push(id);
        continue;
      }
      const receivedAt = new Date(evt.receivedAt);
      const cur = perVehicle.get(evt.vehicleId);
      if (!cur) {
        perVehicle.set(evt.vehicleId, { tenantId: evt.tenantId, receivedAt, ids: [id] });
      } else {
        cur.ids.push(id);
        if (receivedAt > cur.receivedAt) cur.receivedAt = receivedAt;
      }
    }

    const work = [...perVehicle.entries()];
    let failed = 0;
    for (let i = 0; i < work.length; i += APPLY_CONCURRENCY) {
      await Promise.all(
        work.slice(i, i + APPLY_CONCURRENCY).map(async ([vehicleId, v]) => {
          try {
            await this.alertState.recordSeen(vehicleId, v.tenantId, v.receivedAt);
            ackable.push(...v.ids);
          } catch (err: any) {
            failed += v.ids.length;
            this.logger.warn(`recordSeen failed for ${vehicleId}, leaving ${v.ids.length} entr(ies) pending: ${err.message}`);
          }
        }),
      );
    }
    if (ackable.length) {
      await this.redis.xack(TELEMETRY_STREAM, ALERTING_CONSUMER_GROUP, ...ackable);
    }
    if (failed) throw new Error(`${failed} stream entr(ies) left pending for retry`);
  }
}
