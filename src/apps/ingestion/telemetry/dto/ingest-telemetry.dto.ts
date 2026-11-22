import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsNumber, IsString } from 'class-validator';

export class IngestTelemetryDto {
  @ApiProperty({ example: 'TRUCK-001' })
  @IsString()
  vehicleId: string;

  @ApiProperty({ format: 'date-time', description: 'Device-side timestamp (ISO 8601)', example: '2026-11-22T08:30:00.000Z' })
  @IsDateString()
  recordedAt: string;

  @ApiProperty({ example: 6.9271 })
  @IsNumber()
  lat: number;

  @ApiProperty({ example: 79.8612 })
  @IsNumber()
  lng: number;
}
