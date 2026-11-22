import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class CreateVehicleDto {
  @ApiProperty({
    description: 'Globally unique device id (letters, digits, _ or -, max 64)',
    pattern: '^[A-Za-z0-9_-]{1,64}$',
    example: 'TRUCK-001',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  vehicleId: string;

  @ApiProperty({ example: 'north-fleet' })
  @IsString()
  fleetName: string;
}
