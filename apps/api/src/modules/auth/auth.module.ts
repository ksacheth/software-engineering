import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

/**
 * F.1 — User Authentication & Access Control (module 0.1).
 * TODO(F.1): registration, login, JWT access/refresh rotation, MFA (TOTP),
 * role guard (ADMIN/ANALYST/DEVELOPER/VIEWER), organisation isolation.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
