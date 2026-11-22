import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Alert, AlertDocument } from './schemas/alert.schema';
import { VehicleState, VehicleStateDocument } from './schemas/vehicle-state.schema';
import { LastSeenVerifier } from './last-seen.verifier';

export const OFFLINE_THRESHOLD_MS = 15 * 60 * 1000;
export const OFFLINE_ALERT = 'vehicle-offline';
const SWEEP_BATCH = 500; // must be <= LAST_SEEN_BATCH_MAX
const CLAIM_CONCURRENCY = 25;

type StateRow = VehicleState & { _id: Types.ObjectId };

/**
 * Every transition is a conditional update on the same state document the
 * consumer writes, so stale reads, parallel replicas and out-of-order events
 * can't raise duplicate or false alerts.
 */
@Injectable()
export class AlertStateService {
  private readonly logger = new Logger(AlertStateService.name);

  constructor(
    @InjectModel(Alert.name) private readonly alertModel: Model<AlertDocument>,
    @InjectModel(VehicleState.name) private readonly stateModel: Model<VehicleStateDocument>,
    private readonly verifier: LastSeenVerifier,
  ) {}

  private get states() {
    return this.stateModel.collection;
  }

  /** Consumer side: apply one telemetry.received event. Idempotent, order-insensitive. */
  async recordSeen(vehicleId: string, tenantId: string, receivedAt: Date): Promise<void> {
    const state = (await this.states.findOneAndUpdate(
      { vehicleId },
      {
        $max: { lastSeenAt: receivedAt },
        $setOnInsert: {
          tenantId,
          openOfflineAlertId: null,
          offlineSince: null,
          alertMaterialized: true,
          acknowledgedLastSeenAt: null,
        },
      },
      { upsert: true, returnDocument: 'after' },
    )) as unknown as StateRow | null;

    if (state?.openOfflineAlertId && state.offlineSince && state.lastSeenAt > state.offlineSince) {
      await this.autoResolve(state.vehicleId, state.openOfflineAlertId, state.lastSeenAt);
    }
  }

  private async autoResolve(vehicleId: string, alertId: Types.ObjectId, seenAt: Date) {
    // CAS on the pointer, so of N concurrent consumers exactly one resolves.
    const before = (await this.states.findOneAndUpdate(
      { vehicleId, openOfflineAlertId: alertId, offlineSince: { $lt: seenAt } },
      { $set: { openOfflineAlertId: null, offlineSince: null, alertMaterialized: true } },
      { returnDocument: 'before' },
    )) as unknown as StateRow | null;
    if (!before) return;
    if (!before.alertMaterialized) {
      // Sweeper stopped between claim and insert; the vehicle was still offline.
      await this.materialize(before, alertId);
    }
    await this.alertModel
      .updateOne(
        { _id: alertId, status: 'open' },
        { $set: { status: 'resolved', resolvedAt: new Date(), resolvedBy: 'auto:telemetry' } },
      )
      .exec();
  }

  /** Safe on every replica; the Redis lock only saves work. */
  async sweep(now = new Date()): Promise<{ raised: number; skipped: number; candidates: number; ms: number }> {
    const started = Date.now();
    await this.repairUnmaterialized();
    const cutoff = new Date(now.getTime() - OFFLINE_THRESHOLD_MS);
    let raised = 0;
    let skipped = 0;
    let total = 0;
    let lastId: Types.ObjectId | null = null;

    for (;;) {
      const candidates = (await this.states
        .find({
          openOfflineAlertId: null,
          lastSeenAt: { $lt: cutoff },
          $expr: { $ne: ['$acknowledgedLastSeenAt', '$lastSeenAt'] },
          ...(lastId ? { _id: { $gt: lastId } } : {}),
        })
        .sort({ _id: 1 })
        .limit(SWEEP_BATCH)
        .toArray()) as unknown as StateRow[];
      if (candidates.length === 0) break;
      lastId = candidates[candidates.length - 1]._id;
      total += candidates.length;

      // The projection can miss events, so confirm with ingestion first.
      // If ingestion is down, alert anyway: a false alarm beats silence.
      const authoritative = await this.verifier.lastSeenMany(candidates.map((c) => c.vehicleId));

      for (let i = 0; i < candidates.length; i += CLAIM_CONCURRENCY) {
        const results = await Promise.all(
          candidates
            .slice(i, i + CLAIM_CONCURRENCY)
            .map((c) => this.tryRaise(c, cutoff, authoritative.get(c.vehicleId) ?? null)),
        );
        raised += results.filter(Boolean).length;
        skipped += results.filter((r) => !r).length;
      }
    }
    const ms = Date.now() - started;
    if (total > 0) {
      this.logger.log(`offline sweep: ${total} candidate(s), raised ${raised}, skipped ${skipped} in ${ms}ms`);
    }
    return { raised, skipped, candidates: total, ms };
  }

  private async tryRaise(candidate: StateRow, cutoff: Date, authoritative: Date | null): Promise<boolean> {
    let observed = candidate.lastSeenAt;

    if (authoritative && authoritative > observed) {
      await this.states.updateOne({ vehicleId: candidate.vehicleId }, { $max: { lastSeenAt: authoritative } });
      if (authoritative >= cutoff) return false;
      observed = authoritative;
    }

    const alertId = new Types.ObjectId();
    const claimed = (await this.states.findOneAndUpdate(
      {
        vehicleId: candidate.vehicleId,
        openOfflineAlertId: null,
        lastSeenAt: observed, // exact match: any telemetry since our read makes this a no-op
        acknowledgedLastSeenAt: { $ne: observed },
      },
      { $set: { openOfflineAlertId: alertId, offlineSince: observed, alertMaterialized: false } },
      { returnDocument: 'after' },
    )) as unknown as StateRow | null;
    if (!claimed) return false;

    await this.materialize(claimed, alertId);
    await this.states.updateOne(
      { vehicleId: claimed.vehicleId, openOfflineAlertId: alertId },
      { $set: { alertMaterialized: true } },
    );
    return true;
  }

  /** Idempotent insert of the alert + its outbox entry, keyed by the claimed id. */
  private async materialize(state: StateRow, alertId: Types.ObjectId) {
    const offlineSince = state.offlineSince ?? state.lastSeenAt;
    try {
      await this.alertModel
        .updateOne(
          { _id: alertId },
          {
            $setOnInsert: {
              tenantId: state.tenantId,
              vehicleId: state.vehicleId,
              type: OFFLINE_ALERT,
              message: `Vehicle ${state.vehicleId} has not reported telemetry since ${offlineSince.toISOString()}`,
              status: 'open',
              resolvedAt: null,
              resolvedBy: null,
              offlineSince,
              delivery: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), lockedUntil: null },
            },
          },
          { upsert: true },
        )
        .exec();
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
      // An open alert already exists (e.g. legacy); adopt it instead of opening a second.
      const existing = await this.alertModel
        .findOne({ vehicleId: state.vehicleId, type: OFFLINE_ALERT, status: 'open' })
        .exec();
      this.logger.warn(`open alert already existed for ${state.vehicleId}; adopting ${existing?._id}`);
      if (existing) {
        await this.states.updateOne(
          { vehicleId: state.vehicleId, openOfflineAlertId: alertId },
          { $set: { openOfflineAlertId: existing._id, alertMaterialized: true } },
        );
      }
    }
  }

  /** Repairs the crash window between claim and insert. */
  private async repairUnmaterialized() {
    const stuck = (await this.states
      .find({ openOfflineAlertId: { $ne: null }, alertMaterialized: false })
      .limit(SWEEP_BATCH)
      .toArray()) as unknown as StateRow[];
    for (const s of stuck) {
      await this.materialize(s, s.openOfflineAlertId as Types.ObjectId);
      await this.states.updateOne(
        { vehicleId: s.vehicleId, openOfflineAlertId: s.openOfflineAlertId },
        { $set: { alertMaterialized: true } },
      );
    }
  }

  findActiveForVehicle(tenantId: string, vehicleId: string) {
    return this.alertModel.find({ tenantId, vehicleId, status: 'open' }).sort({ createdAt: -1 }).exec();
  }

  /** Acknowledges the current offline episode only; new telemetry starts a new one. */
  async resolveManually(tenantId: string, alertId: string, resolvedBy: string) {
    if (!Types.ObjectId.isValid(alertId)) throw new NotFoundException();
    const _id = new Types.ObjectId(alertId);
    const alert = await this.alertModel.findOne({ _id, tenantId }).exec();
    if (!alert) throw new NotFoundException();
    if (alert.status !== 'open') return alert;

    await this.states.updateOne({ vehicleId: alert.vehicleId, openOfflineAlertId: _id }, [
      {
        $set: {
          openOfflineAlertId: null,
          offlineSince: null,
          alertMaterialized: true,
          acknowledgedLastSeenAt: '$lastSeenAt',
        },
      },
    ]);
    await this.alertModel
      .updateOne({ _id, status: 'open' }, { $set: { status: 'resolved', resolvedAt: new Date(), resolvedBy } })
      .exec();
    this.logger.log(`alert ${alertId} for ${alert.vehicleId} resolved manually by ${resolvedBy}`);
    return this.alertModel.findById(_id).exec();
  }
}
