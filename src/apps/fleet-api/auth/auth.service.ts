import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { User, UserDocument } from './schemas/user.schema';
import { JwtPayload, Role } from '../../../libs/auth/types';

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private jwtService: JwtService,
  ) {}

  /** Admin-only: creates a user in the caller's tenant. */
  async register(
    tenantId: string,
    email: string,
    password: string,
    role: Role = 'dispatcher',
  ): Promise<{ id: string; email: string; tenantId: string; role: Role }> {
    const passwordHash = await bcrypt.hash(password, 10);
    try {
      const user = await this.userModel.create({ email, passwordHash, tenantId, role });
      return { id: user._id.toString(), email: user.email, tenantId, role };
    } catch (err: any) {
      if (err?.code === 11000) throw new ConflictException('Email already registered');
      throw err;
    }
  }

  async login(email: string, password: string): Promise<{ accessToken: string }> {
    const user = await this.userModel.findOne({ email: email.toLowerCase().trim() }).exec();
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const matches = await bcrypt.compare(password, user.passwordHash);
    // A user without a tenant is treated like a bad password.
    if (!matches || !user.tenantId) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const payload: JwtPayload = {
      sub: user._id.toString(),
      email: user.email,
      tenantId: user.tenantId,
      role: user.role,
    };
    return { accessToken: this.jwtService.sign(payload) };
  }
}
