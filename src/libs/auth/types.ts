export type Role = 'admin' | 'dispatcher';

export interface JwtPayload {
  sub: string;
  email: string;
  tenantId?: string;
  role?: Role;
}

/** What `req.user` holds after JwtStrategy.validate. */
export interface AuthUser {
  userId: string;
  email: string;
  tenantId: string;
  role: Role;
}
