import { Injectable, Logger } from '@nestjs/common';
import { AlertDocument } from '../schemas/alert.schema';

// Webhook (NOTIFY_WEBHOOK_URL) or a log line; the alert id is the idempotency key.
// NOTIFY_SIMULATED_FAILURE_RATE (0..1) injects failures for local testing.
@Injectable()
export class Notifier {
  private readonly logger = new Logger('Notifier');
  private readonly webhook = process.env.NOTIFY_WEBHOOK_URL;
  private readonly failureRate = Number(process.env.NOTIFY_SIMULATED_FAILURE_RATE || 0);

  async send(alert: AlertDocument): Promise<void> {
    if (this.failureRate > 0 && Math.random() < this.failureRate) {
      throw new Error('simulated channel failure');
    }
    const payload = {
      alertId: alert._id.toString(),
      tenantId: alert.tenantId,
      vehicleId: alert.vehicleId,
      type: alert.type,
      message: alert.message,
      status: alert.status,
      raisedAt: (alert as any).createdAt,
    };
    if (!this.webhook) {
      this.logger.log(`[deliver] ${JSON.stringify(payload)}`);
      return;
    }
    const res = await fetch(this.webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': payload.alertId },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`webhook responded ${res.status}`);
  }
}
