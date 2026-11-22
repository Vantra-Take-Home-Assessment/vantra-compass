import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'crypto';
import { config } from '../config';
import { AuthUser, Role } from './types';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** Use after JwtAuthGuard. No @Roles() metadata means any authenticated user. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const user = ctx.switchToHttp().getRequest().user as AuthUser | undefined;
    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);

export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

// Service-to-service calls (/internal/*); second layer behind the gateway's 404.
@Injectable()
export class InternalGuard implements CanActivate {
  private readonly expected = Buffer.from(config.internalToken());

  canActivate(ctx: ExecutionContext): boolean {
    const given = ctx.switchToHttp().getRequest().headers[INTERNAL_TOKEN_HEADER];
    const buf = Buffer.from(typeof given === 'string' ? given : '');
    if (buf.length !== this.expected.length || !timingSafeEqual(buf, this.expected)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
