import { Module, forwardRef } from '@nestjs/common';
import { AuthService } from './auth.service';
import { EmployeeService } from './employee.service';
import { AuthController } from './auth.controller';
import { EmployeeController } from './employee.controller';
import { PrismaService } from '../prisma/prisma.service';
import { LocationsModule } from '../locations/locations.module';
import {
  DeviceGuard,
  AuthGuard,
  LocationGuard,
} from './guards/auth.guard';

@Module({
  imports: [forwardRef(() => LocationsModule)],
  controllers: [AuthController, EmployeeController],
  providers: [
    PrismaService,
    AuthService,
    EmployeeService,
    DeviceGuard,
    AuthGuard,
    LocationGuard,
  ],
  exports: [
    AuthService,
    EmployeeService,
    DeviceGuard,
    AuthGuard,
    LocationGuard,
  ],
})
export class AuthModule {}
