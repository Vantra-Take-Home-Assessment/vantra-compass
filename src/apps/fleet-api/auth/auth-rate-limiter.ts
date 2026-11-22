import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { InjectRedis } from '../../../libs/redis/redis.module';

const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 60;

// Fixed-window counter in Redis, shared by replicas. Fails open so a Redis
// outage doesn't lock dispatchers out.
@Injectable()
export class AuthRateLimiter {
  private readonly logger = new Logger(AuthRateLimiter.name);

  constructor(@InjectRedis() private readonly redis: Redis) {}

  async checkAndRecord(email: string) {
    const key = `ratelimit:login:${email.toLowerCase().trim()}`;
    if (this.redis.status !== 'ready') {
      // Fail fast instead of waiting in ioredis' offline queue.
      this.logger.warn(`login rate limiter unavailable (redis ${this.redis.status}), allowing attempt`);
      return;
    }
    let count: number;
    try {
      const [[err, n]] = (await this.redis
        .multi()
        .incr(key)
        .expire(key, WINDOW_SECONDS, 'NX')
        .exec()) as [[Error | null, number]];
      if (err) throw err;
      count = n;
    } catch (err: any) {
      this.logger.warn(`login rate limiter unavailable, allowing attempt: ${err.message}`);
      return;
    }
    if (count > MAX_ATTEMPTS) {
      throw new HttpException('Too many login attempts, try again shortly', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
