import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './common/health.controller';
import { AuthModule } from './modules/auth/auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // .env lives at the repo root; fall back to it when turbo runs us from apps/api.
      envFilePath: ['.env', '../../.env'],
    }),
    AuthModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
