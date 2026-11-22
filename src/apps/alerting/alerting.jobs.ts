import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import Redis from 'ioredis';
import { InjectRedis } from '../../libs/redis/redis.module';
import { AlertStateService } from './alert-state.service';
import { AlertDispatcher } from './delivery/alert-dispatcher';

const SWEEP_LOCK = 'lock:alerting:offline-sweep';

@Injectable()
export class AlertingJobs {
  private readonly logger = new Logger(AlertingJobs.name);
  private sweeping = false;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly alertState: AlertStateService,
    private readonly dispatcher: AlertDispatcher,
  ) {}

  // The lock only saves duplicate work; the CAS prevents double alerts.
  @Interval(60_000)
  async offlineSweep() {
    if (this.sweeping) return;
    const got = await this.redis.set(SWEEP_LOCK, process.pid.toString(), 'PX', 55_000, 'NX').catch(() => 'OK');
    if (!got) return;
    this.sweeping = true;
    try {
      await this.alertState.sweep();
    } catch (err: any) {
      this.logger.error(`offline sweep failed: ${err.message}`);
    } finally {
      this.sweeping = false;
    }
  }

  @Interval(2_000)
  async dispatch() {
    try {
      await this.dispatcher.drain();
    } catch (err: any) {
      this.logger.error(`dispatcher tick failed: ${err.message}`);
    }
  }
}
