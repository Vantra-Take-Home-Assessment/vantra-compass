import { Body, Controller, Get, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../libs/auth/jwt-auth.guard';
import { CurrentUser, InternalGuard, Roles, RolesGuard } from '../../../libs/auth/guards';
import { AuthUser } from '../../../libs/auth/types';
import { SWAGGER_INTERNAL, SWAGGER_JWT } from '../../../libs/swagger';
import { VehiclesService } from './vehicles.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';

@ApiTags('vehicles')
@ApiBearerAuth(SWAGGER_JWT)
@Controller('vehicles')
@UseGuards(JwtAuthGuard, RolesGuard)
export class VehiclesController {
  constructor(private readonly vehiclesService: VehiclesService) {}

  @Get()
  @ApiOperation({ summary: "List the caller's tenant vehicles" })
  findAll(@CurrentUser() user: AuthUser) {
    return this.vehiclesService.findAll(user.tenantId);
  }

  @Get(':vehicleId')
  @ApiOperation({ summary: "Get one vehicle in the caller's tenant" })
  findOne(@CurrentUser() user: AuthUser, @Param('vehicleId') vehicleId: string) {
    return this.vehiclesService.findByVehicleId(user.tenantId, vehicleId);
  }

  @Post()
  @Roles('admin')
  @ApiOperation({ summary: "Register a vehicle in the caller's tenant (admin only)" })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateVehicleDto) {
    return this.vehiclesService.create(user.tenantId, dto.vehicleId, dto.fleetName);
  }
}

/** Registry lookup used by ingestion when the Redis registry misses. */
@ApiTags('internal')
@ApiSecurity(SWAGGER_INTERNAL)
@Controller('internal/vehicles')
@UseGuards(InternalGuard)
export class InternalVehiclesController {
  constructor(private readonly vehiclesService: VehiclesService) {}

  @Get(':vehicleId')
  @ApiOperation({ summary: 'Registry lookup: vehicleId -> tenantId/status (service-to-service)' })
  async lookup(@Param('vehicleId') vehicleId: string) {
    const v = await this.vehiclesService.findForRegistry(vehicleId);
    if (!v || !v.tenantId) throw new NotFoundException();
    return { vehicleId: v.vehicleId, tenantId: v.tenantId, status: v.status };
  }
}
