// Cross-service Redis keys, streams and event shapes. Each key has one writer.

/** Hash vehicleId -> tenantId. Writer: fleet-api. Readers: ingestion. */
export const VEHICLE_REGISTRY_KEY = 'vehreg';

/** JSON list of a tenant's vehicles, TTL'd. Writer + reader: fleet-api. */
export const tenantVehiclesKey = (tenantId: string) => `fleet:${tenantId}:vehicles`;

/** Hash vehicleId -> LatestReading per tenant. Writer: ingestion. Reader: fleet-api. */
export const latestKey = (tenantId: string) => `latest:${tenantId}`;
export const LATEST_READY_FIELD = '__ready';
export const LATEST_BUILDING_FIELD = '__building';

/** Max ids per POST ingestion /internal/vehicles/last-seen (alerting's sweep batch must fit). */
export const LAST_SEEN_BATCH_MAX = 1000;

/** Redis stream. Producer: ingestion. Consumer group: alerting. */
export const TELEMETRY_STREAM = 'stream:telemetry.received';
export const ALERTING_CONSUMER_GROUP = 'alerting';

export interface TelemetryReceivedEvent {
  eventId: string;
  tenantId: string;
  vehicleId: string;
  recordedAt: string; // device clock - used for "latest reading" ordering
  receivedAt: string; // server clock - used for liveness / offline detection
}

/** The "latest reading" shape served on the dashboard. */
export interface LatestReading {
  _id: string;
  vehicleId: string;
  recordedAt: string;
  receivedAt: string;
  location?: { lat: number; lng: number };
  batteryLevel?: string | number;
  batteryPct: number | null;
}

// batteryLevel arrives as "87%" strings (old firmware), numbers or missing.
export function normalizeBatteryPct(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const n = Number.parseFloat(raw.replace('%', '').trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
