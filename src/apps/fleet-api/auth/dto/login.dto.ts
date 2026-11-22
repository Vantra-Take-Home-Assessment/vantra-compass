import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString } from 'class-validator';

export class LoginDto {
  @ApiProperty({ format: 'email', example: 'demo@vantra.internal', description: 'Seeded demo user by default' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'demo-password-123' })
  @IsString()
  password: string;
}
