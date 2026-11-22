import 'reflect-metadata';
import { Controller, Get, Logger, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Connection } from 'mongoose';
import Redis from 'ioredis';
import { InjectRedis } from './redis/redis.module';
import { setupSwagger } from './swagger';

// 503 without Mongo. Redis is only "degraded" because every Redis path has a fallback.
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectConnection() private readonly mongo: Connection,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Liveness/readiness: 503 when Mongo is down, Redis reported as degraded' })
  health() {
    const mongo = this.mongo.readyState === 1 ? 'up' : 'down';
    const redis = this.redis.status === 'ready' ? 'up' : 'degraded';
    const body = { ok: mongo === 'up', mongo, redis };
    if (!body.ok) throw new ServiceUnavailableException(body);
    return body;
  }
}

export async function bootstrapService(name: string, module: unknown, defaultPort: number) {
  const app = await NestFactory.create(module as any);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();
  setupSwagger(app, name);
  const port = Number(process.env.PORT) || defaultPort;
  await app.listen(port);
  new Logger(name).log(`listening on port ${port}`);
  return app;
}
