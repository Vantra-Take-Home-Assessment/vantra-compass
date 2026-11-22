/**
 * Simulates devices through the gateway, including retries and late deliveries.
 * Run with: npm run simulate -- --vehicles 50 --interval 5 --duration 120
 */
const args = Object.fromEntries(
  process.argv.slice(2).reduce<[string, string][]>((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, []),
);
const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:3000';
const VEHICLES = Number(args.vehicles || 20);
const INTERVAL_S = Number(args.interval || 5);
const DURATION_S = Number(args.duration || 60);
const DUP_RATE = 0.05;
const LATE_RATE = 0.05;

async function post(body: unknown) {
  const res = await fetch(`${GATEWAY}/ingestion/telemetry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.status;
}

async function tick() {
  const stats: Record<string, number> = {};
  await Promise.all(
    Array.from({ length: VEHICLES }, async (_, i) => {
      const vehicleId = `VH-${String(i + 1).padStart(5, '0')}`;
      const late = Math.random() < LATE_RATE;
      const body = {
        vehicleId,
        recordedAt: new Date(Date.now() - (late ? 10 * 60_000 : 0)).toISOString(),
        lat: 6.9 + Math.random() * 0.2,
        lng: 79.8 + Math.random() * 0.2,
      };
      const s = await post(body);
      stats[s] = (stats[s] || 0) + 1;
      if (Math.random() < DUP_RATE) await post(body); // device retry
    }),
  );
  console.log(new Date().toISOString(), 'status counts', stats);
}

(async () => {
  console.log(`simulating ${VEHICLES} vehicles every ${INTERVAL_S}s for ${DURATION_S}s against ${GATEWAY}`);
  const end = Date.now() + DURATION_S * 1000;
  while (Date.now() < end) {
    await tick();
    await new Promise((r) => setTimeout(r, INTERVAL_S * 1000));
  }
})();
