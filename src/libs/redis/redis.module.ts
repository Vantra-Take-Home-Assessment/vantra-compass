import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { config } from '../config';

export const REDIS = Symbol('REDIS');
export const InjectRedis = () => Inject(REDIS);

class RedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  async onApplicationShutdown() {
    await this.redis.quit().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: () => new Redis(config.redisUrl(), { maxRetriesPerRequest: 3 }),
    },
    RedisShutdown,
  ],
  exports: [REDIS],
})
export class RedisModule {}
