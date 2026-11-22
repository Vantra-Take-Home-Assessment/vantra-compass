/**
 * Project Compass backfill: tenants, tenantId on existing data, and the new
 * projections. Idempotent and additive, so it is safe to re-run while the
 * monolith is still serving. Run with: npm run migrate
 */
import 'reflect-metadata';
import mongoose from 'mongoose';
import * as bcrypt from 'bcrypt';
import { normalizeBatteryPct } from '../src/libs/contracts';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/vantra';
const DEMO_ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD || 'compass-demo-123';
// Tenant for pre-existing users; in production this mapping comes from the business.
const DEFAULT_USER_TENANT = process.env.DEFAULT_USER_TENANT || 'northbound-logistics';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  process.stdout.write(`- ${name} ... `);
  const r = await fn();
  console.log(`done (${Date.now() - t}ms)${r !== undefined ? ' ' + JSON.stringify(r) : ''}`);
  return r;
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db!;
  console.log(`Compass migration against ${MONGO_URI}`);

  const tenants = await step('tenants', async () => {
    const fleets: string[] = await db.collection('vehicles').distinct('fleetName');
    for (const name of fleets) {
      await db.collection('tenants').updateOne(
        { _id: slug(name) as any },
        { $setOnInsert: { name, createdAt: new Date() } },
        { upsert: true },
      );
    }
    return fleets.map((name) => ({ name, id: slug(name) }));
  });

  await step('vehicles.tenantId', async () => {
    let n = 0;
    for (const t of tenants) {
      const r = await db
        .collection('vehicles')
        .updateMany({ fleetName: t.name, tenantId: { $exists: false } }, { $set: { tenantId: t.id } });
      n += r.modifiedCount;
    }
    return { updated: n };
  });

  await step('users', async () => {
    const assigned = await db
      .collection('users')
      .updateMany(
        { email: 'demo@vantra.internal', tenantId: { $exists: false } },
        { $set: { tenantId: DEFAULT_USER_TENANT } },
      );
    // Other tenantless users stay locked out and are flagged for manual review.
    const quarantined = await db.collection('users').countDocuments({ tenantId: { $exists: false } });
    const passwordHash = await bcrypt.hash(DEMO_ADMIN_PASSWORD, 10);
    let admins = 0;
    for (const t of tenants) {
      const r = await db.collection('users').updateOne(
        { email: `admin@${t.id}.demo` },
        { $setOnInsert: { passwordHash, role: 'admin', tenantId: t.id, createdAt: new Date(), updatedAt: new Date() } },
        { upsert: true },
      );
      admins += r.upsertedCount;
    }
    return { demoUserAssigned: assigned.modifiedCount, adminsCreated: admins, tenantlessUsersLockedOut: quarantined };
  });

  await step('telemetry index {vehicleId:1, recordedAt:-1}', async () => {
    await db.collection('telemetryevents').createIndex({ vehicleId: 1, recordedAt: -1 });
  });

  await step('telemetry.tenantId backfill', async () => {
    let n = 0;
    for (const t of tenants) {
      const ids = await db.collection('vehicles').distinct('vehicleId', { tenantId: t.id });
      const r = await db
        .collection('telemetryevents')
        .updateMany({ vehicleId: { $in: ids }, tenantId: { $exists: false } }, { $set: { tenantId: t.id } });
      n += r.modifiedCount;
    }
    return { updated: n };
  });

  await step('vehicle_latest projection', async () => {
    await db.collection('vehicle_latest').createIndex({ vehicleId: 1 }, { unique: true });
    await db.collection('vehicle_latest').createIndex({ tenantId: 1 });
    // Index-ordered scan: one pass, newest recordedAt first per vehicle.
    const cursor = db.collection('telemetryevents').aggregate(
      [
        { $match: { tenantId: { $type: 'string' } } },
        { $sort: { vehicleId: 1, recordedAt: -1 } },
        {
          $group: {
            _id: '$vehicleId',
            tenantId: { $first: '$tenantId' },
            latest: { $first: '$$ROOT' },
            lastReceivedAt: { $max: '$receivedAt' },
          },
        },
      ],
      { allowDiskUse: true },
    );
    let ops: any[] = [];
    let n = 0;
    const flush = async () => {
      if (ops.length) await db.collection('vehicle_latest').bulkWrite(ops, { ordered: false });
      ops = [];
    };
    for await (const g of cursor) {
      const l = g.latest;
      ops.push({
        updateOne: {
          filter: { vehicleId: g._id },
          update: { $max: { lastReceivedAt: g.lastReceivedAt }, $setOnInsert: { tenantId: g.tenantId } },
          upsert: true,
        },
      });
      // Same monotonic rule as live ingestion: only replace an older reading.
      ops.push({
        updateOne: {
          filter: { vehicleId: g._id, $or: [{ recordedAt: { $lt: l.recordedAt } }, { recordedAt: { $exists: false } }] },
          update: {
            $set: {
              eventId: String(l._id),
              recordedAt: l.recordedAt,
              receivedAt: l.receivedAt,
              location: l.location ?? null,
              batteryLevel: l.batteryLevel ?? null,
              batteryPct: normalizeBatteryPct(l.batteryLevel),
            },
          },
        },
      });
      n++;
      if (ops.length >= 2000) await flush();
    }
    await flush();
    return { vehicles: n };
  });

  await step('alerting_vehicle_state', async () => {
    await db.collection('alerting_vehicle_state').createIndex({ vehicleId: 1 }, { unique: true });
    const ops: any[] = [];
    for await (const v of db.collection('vehicle_latest').find({}, { projection: { vehicleId: 1, tenantId: 1, lastReceivedAt: 1 } })) {
      ops.push({
        updateOne: {
          filter: { vehicleId: v.vehicleId },
          update: {
            $max: { lastSeenAt: v.lastReceivedAt },
            $setOnInsert: {
              tenantId: v.tenantId,
              openOfflineAlertId: null,
              offlineSince: null,
              alertMaterialized: true,
              acknowledgedLastSeenAt: null,
            },
          },
          upsert: true,
        },
      });
    }
    if (ops.length) await db.collection('alerting_vehicle_state').bulkWrite(ops, { ordered: false });
    return { vehicles: ops.length };
  });

  await step('legacy alerts', async () => {
    const vehicleTenant = new Map<string, string>();
    for await (const v of db.collection('vehicles').find({}, { projection: { vehicleId: 1, tenantId: 1 } })) {
      vehicleTenant.set(v.vehicleId, v.tenantId);
    }
    let migrated = 0;
    let adopted = 0;
    // Newest first: adopt the newest open legacy alert per vehicle, close the rest.
    for await (const a of db.collection('alerts').find({ status: { $exists: false } }).sort({ createdAt: -1 })) {
      const open = a.resolvedAt == null;
      let status = open ? 'open' : 'resolved';
      if (open) {
        const r = await db.collection('alerting_vehicle_state').updateOne(
          { vehicleId: a.vehicleId, openOfflineAlertId: null },
          [{ $set: { openOfflineAlertId: a._id, offlineSince: '$lastSeenAt', alertMaterialized: true } }],
        );
        if (r.modifiedCount === 1) adopted++;
        else status = 'resolved';
      }
      await db.collection('alerts').updateOne(
        { _id: a._id },
        {
          $set: {
            status,
            tenantId: vehicleTenant.get(a.vehicleId) ?? null,
            resolvedBy: status === 'resolved' && open ? 'migration:duplicate' : a.resolvedBy ?? null,
            ...(status === 'resolved' && open ? { resolvedAt: new Date() } : {}),
            // Never (re)send alerts raised before the outbox existed.
            delivery: { status: 'legacy', attempts: 0, nextAttemptAt: null, lockedUntil: null },
          },
        },
      );
      migrated++;
    }
    return { migrated, adoptedAsOpen: adopted };
  });

  console.log('\nDemo logins (one admin per tenant):');
  for (const t of tenants) console.log(`  admin@${t.id}.demo / ${DEMO_ADMIN_PASSWORD}`);
  console.log(`  demo@vantra.internal / demo-password-123  (dispatcher, tenant ${DEFAULT_USER_TENANT})`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
