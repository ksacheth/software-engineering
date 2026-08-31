import { Controller, Get } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // TODO(F.1): POST /register, POST /login, POST /refresh, POST /logout, POST /mfa/*,
  // HttpOnly/Secure/SameSite=Strict cookies (NFR-SEC-1).
  @Get()
  status(): { module: string; status: string } {
    return { module: 'auth', status: 'scaffolded' };
  }
}
