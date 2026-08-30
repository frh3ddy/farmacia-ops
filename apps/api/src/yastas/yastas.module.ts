import { Module, forwardRef } from '@nestjs/common';
import { YastasController } from './yastas.controller';
import { YastasService } from './yastas.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [YastasController],
  providers: [YastasService, PrismaService],
  exports: [YastasService],
})
export class YastasModule {}
