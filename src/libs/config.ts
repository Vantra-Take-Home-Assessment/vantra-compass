// Secrets fail fast instead of falling back to a default.
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  mongoUri: () => process.env.MONGO_URI || 'mongodb://localhost:27017/vantra',
  redisUrl: () => process.env.REDIS_URL || 'redis://localhost:6379',
  jwtSecret: () => requireEnv('JWT_SECRET'),
  internalToken: () => requireEnv('INTERNAL_TOKEN'),
  fleetApiUrl: () => process.env.FLEET_API_URL || 'http://localhost:3001',
  ingestionUrl: () => process.env.INGESTION_URL || 'http://localhost:3002',
};
