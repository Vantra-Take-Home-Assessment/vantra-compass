import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { User, UserSchema } from './schemas/user.schema';
import { AuthRateLimiter } from './auth-rate-limiter';
import { AuthLibModule } from '../../../libs/auth/auth-lib.module';
import { config } from '../../../libs/config';

@Module({
  imports: [
    AuthLibModule,
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: config.jwtSecret(),
        signOptions: { expiresIn: '12h' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthRateLimiter],
  exports: [AuthService],
})
export class AuthModule {}
