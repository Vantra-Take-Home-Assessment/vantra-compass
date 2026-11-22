import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  let userModel: any;
  let jwtService: JwtService;

  beforeEach(() => {
    userModel = {
      create: jest.fn(),
      findOne: jest.fn(),
    };
    jwtService = new JwtService({ secret: 'test-secret' });
    service = new AuthService(userModel, jwtService);
  });

  it('registers a new user inside the given tenant with a hashed password', async () => {
    userModel.create.mockResolvedValue({ _id: 'abc123', email: 'a@b.com' });
    const result = await service.register('tenant-a', 'a@b.com', 'password123');
    expect(result).toEqual({ id: 'abc123', email: 'a@b.com', tenantId: 'tenant-a', role: 'dispatcher' });
    const created = userModel.create.mock.calls[0][0];
    expect(created.tenantId).toBe('tenant-a');
    expect(created.passwordHash).not.toBe('password123');
  });

  it('throws on login with unknown email', async () => {
    userModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
    await expect(service.login('nope@b.com', 'x')).rejects.toThrow(UnauthorizedException);
  });

  it('throws on login with wrong password', async () => {
    const passwordHash = await bcrypt.hash('correct-password', 4);
    userModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ _id: '1', email: 'a@b.com', passwordHash, tenantId: 't' }),
    });
    await expect(service.login('a@b.com', 'wrong-password')).rejects.toThrow(UnauthorizedException);
  });

  it('refuses login for a user with no tenant (pre-migration / old open registration)', async () => {
    const passwordHash = await bcrypt.hash('correct-password', 4);
    userModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ _id: '1', email: 'a@b.com', passwordHash }),
    });
    await expect(service.login('a@b.com', 'correct-password')).rejects.toThrow(UnauthorizedException);
  });

  it('embeds tenantId and role in the issued token', async () => {
    const passwordHash = await bcrypt.hash('correct-password', 4);
    userModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        _id: '1',
        email: 'a@b.com',
        passwordHash,
        tenantId: 'tenant-a',
        role: 'admin',
      }),
    });
    const { accessToken } = await service.login('a@b.com', 'correct-password');
    const decoded = jwtService.verify(accessToken);
    expect(decoded).toMatchObject({ sub: '1', tenantId: 'tenant-a', role: 'admin' });
  });
});
