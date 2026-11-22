import { INestApplication, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { INTERNAL_TOKEN_HEADER } from './auth/guards';

export const SWAGGER_JWT = 'jwt';
export const SWAGGER_INTERNAL = 'internal-token';

// Off when NODE_ENV=production unless SWAGGER_ENABLED=true.
export function swaggerEnabled(): boolean {
  const flag = process.env.SWAGGER_ENABLED;
  if (flag !== undefined) return flag === 'true';
  return process.env.NODE_ENV !== 'production';
}

// /docs/<service> (JSON at /docs/<service>-json), so services don't collide behind the gateway.
export function setupSwagger(app: INestApplication, service: string): string | undefined {
  if (!swaggerEnabled()) return undefined;

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle(`Vantra Compass: ${service}`)
      .setDescription(
        `HTTP API of the ${service} service. Through the gateway (port 3000), /internal/* routes return 404; ` +
          'call them on the service port directly.',
      )
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, SWAGGER_JWT)
      .addApiKey({ type: 'apiKey', in: 'header', name: INTERNAL_TOKEN_HEADER }, SWAGGER_INTERNAL)
      .build(),
  );

  const path = `docs/${service}`;
  SwaggerModule.setup(path, app, document, { swaggerOptions: { persistAuthorization: true } });
  new Logger(service).log(`swagger at /${path}`);
  return path;
}
