import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './jwt.strategy';
import { InternalGuard, RolesGuard } from './guards';

/** Token *verification* only. Token issuance lives in fleet-api's AuthModule. */
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
  providers: [JwtStrategy, RolesGuard, InternalGuard],
  exports: [PassportModule, RolesGuard, InternalGuard],
})
export class AuthLibModule {}
