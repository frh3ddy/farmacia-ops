import { Module, forwardRef } from '@nestjs/common';
import { LaborController } from './labor.controller';
import { LaborService } from './labor.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [LaborController],
  providers: [LaborService, PrismaService],
  exports: [LaborService],
})
export class LaborModule {}
