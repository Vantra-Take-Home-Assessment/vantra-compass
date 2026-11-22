import { HttpException } from '@nestjs/common';
import { AuthRateLimiter } from './auth-rate-limiter';

const fakeRedis = (status: string, count: number | Error) => ({
  status,
  multi: jest.fn(() => {
    const chain = {
      incr: () => chain,
      expire: () => chain,
      exec: () =>
        count instanceof Error ? Promise.reject(count) : Promise.resolve([[null, count], [null, 1]]),
    };
    return chain;
  }),
});

describe('AuthRateLimiter', () => {
  it('allows up to 5 attempts per window and rejects the 6th with 429', async () => {
    await expect(new AuthRateLimiter(fakeRedis('ready', 5) as any).checkAndRecord('a@b.com')).resolves.toBeUndefined();
    await expect(new AuthRateLimiter(fakeRedis('ready', 6) as any).checkAndRecord('a@b.com')).rejects.toMatchObject({
      status: 429,
    });
  });

  it('fails open immediately when Redis is not connected (no queueing behind retries)', async () => {
    const redis = fakeRedis('reconnecting', 99);
    await expect(new AuthRateLimiter(redis as any).checkAndRecord('a@b.com')).resolves.toBeUndefined();
    expect(redis.multi).not.toHaveBeenCalled();
  });

  it('fails open if the Redis command itself errors', async () => {
    const limiter = new AuthRateLimiter(fakeRedis('ready', new Error('connection reset')) as any);
    await expect(limiter.checkAndRecord('a@b.com')).resolves.toBeUndefined();
  });

  it('still surfaces a real rate-limit as HttpException', async () => {
    const err = await new AuthRateLimiter(fakeRedis('ready', 10) as any).checkAndRecord('x@y.com').catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
  });
});
