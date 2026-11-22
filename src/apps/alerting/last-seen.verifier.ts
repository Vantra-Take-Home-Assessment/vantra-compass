import { Injectable, Logger } from '@nestjs/common';
import { config } from '../../libs/config';
import { INTERNAL_TOKEN_HEADER } from '../../libs/auth/guards';

// Asks ingestion when it last heard from a batch of vehicles. Empty map if unreachable.
@Injectable()
export class LastSeenVerifier {
  private readonly logger = new Logger(LastSeenVerifier.name);

  async lastSeenMany(vehicleIds: string[]): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    if (vehicleIds.length === 0) return out;
    try {
      const res = await fetch(`${config.ingestionUrl()}/internal/vehicles/last-seen`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [INTERNAL_TOKEN_HEADER]: config.internalToken() },
        body: JSON.stringify({ vehicleIds }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`ingestion responded ${res.status}`);
      const body = (await res.json()) as Record<string, string | null>;
      for (const [id, iso] of Object.entries(body)) {
        if (iso) out.set(id, new Date(iso));
      }
    } catch (err: any) {
      this.logger.warn(`last-seen verification for ${vehicleIds.length} vehicle(s) failed: ${err.message}`);
    }
    return out;
  }
}
