// Runs against real Mongo (npm run test:int); the races need real conditional updates.
import mongoose, { Connection, Model } from 'mongoose';
import { AlertStateService, OFFLINE_THRESHOLD_MS } from './alert-state.service';
import { Alert, AlertSchema } from './schemas/alert.schema';
import { VehicleState, VehicleStateSchema } from './schemas/vehicle-state.schema';
import { AlertDispatcher, MAX_ATTEMPTS } from './delivery/alert-dispatcher';
import { LastSeenVerifier } from './last-seen.verifier';
import { TelemetryConsumer } from './telemetry.consumer';

const BASE = process.env.MONGO_URI_TEST || 'mongodb://localhost:27017';
const MIN = 60_000;

describe('AlertStateService (real Mongo)', () => {
  let conn: Connection;
  let alerts: Model<any>;
  let states: Model<any>;
  let verifier: { lastSeenMany: jest.Mock };
  let svc: AlertStateService;

  beforeAll(async () => {
    conn = await mongoose.createConnection(`${BASE}/vantra_int_${Date.now()}`).asPromise();
    alerts = conn.model(Alert.name, AlertSchema);
    states = conn.model(VehicleState.name, VehicleStateSchema);
    await alerts.syncIndexes();
    await states.syncIndexes();
  });
  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });
  beforeEach(async () => {
    await alerts.deleteMany({});
    await states.deleteMany({});
    verifier = { lastSeenMany: jest.fn().mockResolvedValue(new Map()) };
    svc = new AlertStateService(alerts as any, states as any, verifier as unknown as LastSeenVerifier);
  });

  const ago = (ms: number) => new Date(Date.now() - ms);
  const openAlerts = (vehicleId = 'v1') => alerts.countDocuments({ vehicleId, status: 'open' });

  it('lastSeenAt never moves backwards when events arrive out of order or twice', async () => {
    const newer = ago(1 * MIN);
    const older = ago(30 * MIN);
    await svc.recordSeen('v1', 't1', newer);
    await svc.recordSeen('v1', 't1', older);
    await svc.recordSeen('v1', 't1', newer);
    const s = await states.findOne({ vehicleId: 'v1' }).lean<any>();
    expect(s.lastSeenAt.getTime()).toBe(newer.getTime());
    await svc.sweep();
    expect(await openAlerts()).toBe(0);
  });

  describe('cross-boundary race: telemetry lands between the sweep read and the alert write', () => {
    it('NAIVE check-then-act (monolith logic on a projection) leaves an online vehicle with an open offline alert', async () => {
      await svc.recordSeen('v1', 't1', ago(20 * MIN));
      // 1. sweep reads projection: looks offline
      const seen = await states.findOne({ vehicleId: 'v1' }).lean<any>();
      const looksOffline = Date.now() - seen.lastSeenAt.getTime() > OFFLINE_THRESHOLD_MS;
      // 2. telemetry event is consumed in the meantime (nothing to resolve yet)
      await svc.recordSeen('v1', 't1', new Date());
      // 3. sweep acts on its stale read
      if (looksOffline) {
        await alerts.create({ vehicleId: 'v1', tenantId: 't1', type: 'vehicle-offline', message: 'x', status: 'open' });
      }
      // vehicle is online, alert is open, and the event that would resolve it is already gone
      expect(await openAlerts()).toBe(1);
    });

    it('CAS-based sweep does not raise when the event lands mid-sweep', async () => {
      await svc.recordSeen('v1', 't1', ago(20 * MIN));
      // The verifier runs between read and claim, so inject the event there.
      verifier.lastSeenMany.mockImplementation(async () => {
        await svc.recordSeen('v1', 't1', new Date());
        return new Map(); // and pretend ingestion's answer lagged too
      });
      const res = await svc.sweep();
      expect(res.raised).toBe(0);
      expect(await openAlerts()).toBe(0);
    });

    it('if the event lands just *after* the claim, it auto-resolves the alert', async () => {
      await svc.recordSeen('v1', 't1', ago(20 * MIN));
      await svc.sweep();
      expect(await openAlerts()).toBe(1);
      await svc.recordSeen('v1', 't1', new Date());
      expect(await openAlerts()).toBe(0);
      const a = await alerts.findOne({ vehicleId: 'v1' }).lean<any>();
      expect(a.resolvedBy).toBe('auto:telemetry');
    });
  });

  it('N replicas sweeping concurrently raise exactly one alert per offline vehicle', async () => {
    for (let i = 0; i < 50; i++) await svc.recordSeen(`v${i}`, 't1', ago(20 * MIN));
    const replicas = Array.from(
      { length: 5 },
      () => new AlertStateService(alerts as any, states as any, verifier as unknown as LastSeenVerifier),
    );
    await Promise.all(replicas.map((r) => r.sweep()));
    expect(await alerts.countDocuments({ status: 'open' })).toBe(50);
    const dupes = await alerts.aggregate([{ $group: { _id: '$vehicleId', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]);
    expect(dupes).toHaveLength(0);
  });

  it('verifies once per sweep batch, not once per vehicle', async () => {
    for (let i = 0; i < 120; i++) await svc.recordSeen(`v${i}`, 't1', ago(20 * MIN));
    const res = await svc.sweep();
    expect(res.raised).toBe(120);
    expect(verifier.lastSeenMany).toHaveBeenCalledTimes(1);
    expect(verifier.lastSeenMany.mock.calls[0][0]).toHaveLength(120);
  });

  it('verifies with ingestion before alerting: a lost stream event does not cause a false alert', async () => {
    await svc.recordSeen('v1', 't1', ago(20 * MIN));
    verifier.lastSeenMany.mockResolvedValue(new Map([['v1', ago(1 * MIN)]])); // ingestion has heard from it recently
    await svc.sweep();
    expect(await openAlerts()).toBe(0);
    const s = await states.findOne({ vehicleId: 'v1' }).lean<any>();
    expect(Date.now() - s.lastSeenAt.getTime()).toBeLessThan(2 * MIN); // projection repaired
  });

  describe('VANTRA-441 regression', () => {
    it('after a manual resolve, the *same* offline episode is not re-raised', async () => {
      await svc.recordSeen('v1', 't1', ago(20 * MIN));
      await svc.sweep();
      const a = await alerts.findOne({ vehicleId: 'v1' }).lean<any>();
      await svc.resolveManually('t1', a._id.toString(), 'ops@x');
      await svc.sweep();
      expect(await alerts.countDocuments({ vehicleId: 'v1' })).toBe(1);
    });

    it('a NEW offline episode within 6h of a resolved alert DOES alert (6h debounce suppressed it)', async () => {
      await svc.recordSeen('v1', 't1', ago(60 * MIN));
      await svc.sweep();
      const first = await alerts.findOne({ vehicleId: 'v1' }).lean<any>();
      await svc.resolveManually('t1', first._id.toString(), 'ops@x');

      // vehicle comes back briefly, then goes silent again
      await svc.recordSeen('v1', 't1', ago(40 * MIN));
      await svc.sweep(); // now - 40min > 15min -> offline again
      expect(await alerts.countDocuments({ vehicleId: 'v1' })).toBe(2);
      expect(await openAlerts()).toBe(1);
    });

    it('manual resolve is tenant-scoped', async () => {
      await svc.recordSeen('v1', 't1', ago(20 * MIN));
      await svc.sweep();
      const a = await alerts.findOne({ vehicleId: 'v1' }).lean<any>();
      await expect(svc.resolveManually('other-tenant', a._id.toString(), 'x')).rejects.toThrow();
      expect(await openAlerts()).toBe(1);
    });
  });

  it('repairs a claim whose alert insert never happened (crash between claim and insert)', async () => {
    const claimed = new mongoose.Types.ObjectId();
    await states.collection.insertOne({
      vehicleId: 'v1', tenantId: 't1', lastSeenAt: ago(20 * MIN),
      openOfflineAlertId: claimed, offlineSince: ago(20 * MIN), alertMaterialized: false, acknowledgedLastSeenAt: null,
    });
    await svc.sweep();
    const a = await alerts.findById(claimed).lean<any>();
    expect(a).toMatchObject({ vehicleId: 'v1', status: 'open' });
    expect(a.delivery.status).toBe('pending');
  });

  describe('AlertDispatcher (outbox)', () => {
    it('retries with backoff until delivered, exactly once marked sent', async () => {
      await svc.recordSeen('v1', 't1', ago(20 * MIN));
      await svc.sweep();
      const send = jest.fn()
        .mockRejectedValueOnce(new Error('smtp down'))
        .mockRejectedValueOnce(new Error('smtp down'))
        .mockResolvedValue(undefined);
      const d = new AlertDispatcher(alerts as any, { send } as any);
      let clock = Date.now();
      const now = () => new Date(clock);
      for (let i = 0; i < 5; i++) {
        await d.drain(now);
        clock += 10 * MIN; // jump past any backoff
      }
      const a = await alerts.findOne({ vehicleId: 'v1' }).lean<any>();
      expect(send).toHaveBeenCalledTimes(3);
      expect(a.delivery).toMatchObject({ status: 'sent', attempts: 3 });
    });

    it('dead-letters after MAX_ATTEMPTS but keeps the alert', async () => {
      await svc.recordSeen('v1', 't1', ago(20 * MIN));
      await svc.sweep();
      const d = new AlertDispatcher(alerts as any, { send: jest.fn().mockRejectedValue(new Error('nope')) } as any);
      let clock = Date.now();
      for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
        await d.drain(() => new Date(clock));
        clock += 10 * MIN;
      }
      const a = await alerts.findOne({ vehicleId: 'v1' }).lean<any>();
      expect(a.delivery.status).toBe('failed');
      expect(a.delivery.attempts).toBe(MAX_ATTEMPTS);
      expect(a.status).toBe('open');
    });

    it('parallel workers on two replicas deliver every alert exactly once', async () => {
      for (let i = 0; i < 60; i++) await svc.recordSeen(`v${i}`, 't1', ago(20 * MIN));
      await svc.sweep();
      const sent: string[] = [];
      const send = jest.fn(async (a: any) => {
        await new Promise((r) => setTimeout(r, 5)); // let workers interleave
        sent.push(a._id.toString());
      });
      const d1 = new AlertDispatcher(alerts as any, { send } as any);
      const d2 = new AlertDispatcher(alerts as any, { send } as any);
      await Promise.all([d1.drain(undefined, 8), d2.drain(undefined, 8)]);
      expect(sent).toHaveLength(60);
      expect(new Set(sent).size).toBe(60);
      expect(await alerts.countDocuments({ 'delivery.status': 'sent' })).toBe(60);
    });

    it('a sender that dies mid-delivery loses its lease and the alert is retried', async () => {
      await svc.recordSeen('v1', 't1', ago(20 * MIN));
      await svc.sweep();
      // simulate a crashed replica: claimed ('sending') with a lease, never finished
      await alerts.updateOne({ vehicleId: 'v1' }, { $set: { 'delivery.status': 'sending', 'delivery.lockedUntil': new Date(Date.now() + 30_000), 'delivery.attempts': 1 } });
      const send = jest.fn().mockResolvedValue(undefined);
      const d = new AlertDispatcher(alerts as any, { send } as any);
      await d.drain(() => new Date());
      expect(send).not.toHaveBeenCalled(); // lease still held
      await d.drain(() => new Date(Date.now() + 60_000));
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  describe('TelemetryConsumer batch apply', () => {
    const entry = (id: string, vehicleId: string, receivedAt: Date): [string, string[]] => [
      id,
      ['data', JSON.stringify({ eventId: id, tenantId: 't1', vehicleId, recordedAt: receivedAt.toISOString(), receivedAt: receivedAt.toISOString() })],
    ];
    const makeConsumer = (state: AlertStateService) => {
      const xack = jest.fn().mockResolvedValue(1);
      const consumer = new TelemetryConsumer({ xack } as any, state);
      return { consumer, xack, handle: (e: [string, string[]][]) => (consumer as any).handle(e) };
    };

    it('coalesced batch reaches the same end state as per-event apply (incl. auto-resolve)', async () => {
      // v1 is offline with an open alert; v2 is new
      await svc.recordSeen('v1', 't1', ago(30 * MIN));
      await svc.sweep();
      expect(await openAlerts('v1')).toBe(1);

      const newest = ago(1 * MIN);
      const { handle, xack } = makeConsumer(svc);
      await handle([
        entry('1-0', 'v1', newest),          // newest first ...
        entry('1-1', 'v2', ago(5 * MIN)),
        entry('1-2', 'v1', ago(40 * MIN)),   // ... then a late, older delivery
        ['1-3', ['data', '{not json']],      // poison: dropped and acked
        entry('1-4', 'v1', newest),          // duplicate
      ]);

      const s1 = await states.findOne({ vehicleId: 'v1' }).lean<any>();
      expect(s1.lastSeenAt.getTime()).toBe(newest.getTime());
      expect(await openAlerts('v1')).toBe(0); // auto-resolved
      expect((await states.findOne({ vehicleId: 'v2' }).lean<any>()).lastSeenAt).toBeTruthy();
      expect(xack).toHaveBeenCalledTimes(1); // one XACK for the batch
      expect(xack.mock.calls[0].slice(2).sort()).toEqual(['1-0', '1-1', '1-2', '1-3', '1-4']);
    });

    it('entries whose write fails are left pending (not acked); the rest are acked', async () => {
      const flaky = new AlertStateService(alerts as any, states as any, verifier as unknown as LastSeenVerifier);
      const real = flaky.recordSeen.bind(flaky);
      flaky.recordSeen = jest.fn(async (vehicleId: string, tenantId: string, at: Date) => {
        if (vehicleId === 'bad') throw new Error('mongo blip');
        return real(vehicleId, tenantId, at);
      }) as any;
      const { handle, xack } = makeConsumer(flaky);
      await expect(handle([entry('2-0', 'ok', ago(1 * MIN)), entry('2-1', 'bad', ago(1 * MIN))])).rejects.toThrow(/pending/);
      expect(xack.mock.calls[0].slice(2)).toEqual(['2-0']);
    });
  });
});
