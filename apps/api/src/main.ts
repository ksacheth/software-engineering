import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // NFR-SEC-1 baseline: security headers + CORS for the dashboard SPA.
  app.use(helmet());
  app.enableCors({
    origin: process.env.WEB_ORIGIN?.split(',') ?? ['http://localhost:3000'],
    credentials: true,
  });

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // DC-6: OpenAPI generated from code (TODO: switch to OpenAPI 3.1).
  const openapi = new DocumentBuilder()
    .setTitle('WVS API')
    .setDescription('Website Vulnerability Scanner — REST API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, openapi));

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);

  new Logger('Bootstrap').log(
    `API listening on http://localhost:${port}/api (OpenAPI docs at /docs)`,
  );
}

void bootstrap();
