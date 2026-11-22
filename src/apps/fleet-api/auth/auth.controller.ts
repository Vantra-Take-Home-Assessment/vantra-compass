import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { AuthRateLimiter } from './auth-rate-limiter';
import { JwtAuthGuard } from '../../../libs/auth/jwt-auth.guard';
import { CurrentUser, Roles, RolesGuard } from '../../../libs/auth/guards';
import { AuthUser } from '../../../libs/auth/types';
import { SWAGGER_JWT } from '../../../libs/swagger';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly rateLimiter: AuthRateLimiter,
  ) {}

  /** Admin-only: creates a user in the admin's own tenant. */
  @Post('register')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth(SWAGGER_JWT)
  @ApiOperation({ summary: "Create a user in the caller's tenant (admin only)" })
  register(@CurrentUser() admin: AuthUser, @Body() dto: RegisterDto) {
    return this.authService.register(admin.tenantId, dto.email, dto.password, dto.role);
  }

  @Post('login')
  @ApiOperation({ summary: 'Exchange email/password for a JWT (rate limited per email)' })
  async login(@Body() dto: LoginDto) {
    await this.rateLimiter.checkAndRecord(dto.email);
    return this.authService.login(dto.email, dto.password);
  }
}
