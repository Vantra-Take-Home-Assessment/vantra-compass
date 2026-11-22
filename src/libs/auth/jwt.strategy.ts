import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { config } from '../config';
import { AuthUser, JwtPayload } from './types';

// Each service verifies tokens locally, so auth doesn't depend on fleet-api at runtime.
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.jwtSecret(),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    // Old tokens carry no tenant; rejecting them forces a re-login.
    if (!payload.tenantId) {
      throw new UnauthorizedException('Token has no tenant; please log in again');
    }
    return {
      userId: payload.sub,
      email: payload.email,
      tenantId: payload.tenantId,
      role: payload.role || 'dispatcher',
    };
  }
}
