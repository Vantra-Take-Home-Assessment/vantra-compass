import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Alert, AlertDocument } from '../schemas/alert.schema';
import { Notifier } from './notifier';

const LEASE_MS = 30_000;
export const MAX_ATTEMPTS = 8;
const MAX_PER_DRAIN = 2_000;
export const DELIVERY_CONCURRENCY = Number(process.env.NOTIFY_CONCURRENCY) || 16;

export function backoffMs(attempt: number) {
  // 2s, 4s, 8s ... capped at 5 min
  return Math.min(2_000 * 2 ** (attempt - 1), 5 * 60_000);
}

// Drains the outbox. Each alert is claimed with an atomic lease, so any number
// of workers and replicas can run this; delivery is at-least-once.
@Injectable()
export class AlertDispatcher {
  private readonly logger = new Logger(AlertDispatcher.name);
  private busy = false;

  constructor(
    @InjectModel(Alert.name) private readonly alertModel: Model<AlertDocument>,
    private readonly notifier: Notifier,
  ) {}

  async drain(now = () => new Date(), concurrency = DELIVERY_CONCURRENCY): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let processed = 0;
    const worker = async () => {
      while (processed < MAX_PER_DRAIN) {
        const alert = await this.claimNext(now());
        if (!alert) return;
        processed++;
        await this.deliver(alert);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    } finally {
      this.busy = false;
    }
    return processed;
  }

  private claimNext(t: Date) {
    return this.alertModel
      .findOneAndUpdate(
        {
          'delivery.status': { $in: ['pending', 'sending'] },
          'delivery.nextAttemptAt': { $lte: t },
          $or: [{ 'delivery.lockedUntil': null }, { 'delivery.lockedUntil': { $lt: t } }],
        },
        {
          $set: { 'delivery.status': 'sending', 'delivery.lockedUntil': new Date(t.getTime() + LEASE_MS) },
          $inc: { 'delivery.attempts': 1 },
        },
        { new: true, sort: { 'delivery.nextAttemptAt': 1 } },
      )
      .exec();
  }

  private async deliver(alert: AlertDocument) {
    const attempts = alert.delivery!.attempts;
    try {
      await this.notifier.send(alert);
      await this.alertModel
        .updateOne(
          { _id: alert._id },
          { $set: { 'delivery.status': 'sent', 'delivery.sentAt': new Date(), 'delivery.lockedUntil': null, 'delivery.lastError': null } },
        )
        .exec();
    } catch (err: any) {
      const dead = attempts >= MAX_ATTEMPTS;
      await this.alertModel
        .updateOne(
          { _id: alert._id },
          {
            $set: {
              'delivery.status': dead ? 'failed' : 'pending',
              'delivery.nextAttemptAt': dead ? null : new Date(Date.now() + backoffMs(attempts)),
              'delivery.lockedUntil': null,
              'delivery.lastError': String(err.message).slice(0, 500),
            },
          },
        )
        .exec();
      const msg = `delivery of alert ${alert._id} attempt ${attempts} failed: ${err.message}`;
      // Ops pages on the DEAD-LETTER line.
      dead ? this.logger.error(`DEAD-LETTER ${msg}`) : this.logger.warn(msg);
    }
  }
}
