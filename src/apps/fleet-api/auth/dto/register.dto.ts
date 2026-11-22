import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { Role } from '../../../../libs/auth/types';

export class RegisterDto {
  @ApiProperty({ format: 'email', example: 'dispatcher@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ minLength: 8, example: 'changeme123' })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiPropertyOptional({ enum: ['admin', 'dispatcher'] })
  @IsOptional()
  @IsIn(['admin', 'dispatcher'])
  role?: Role;
}
