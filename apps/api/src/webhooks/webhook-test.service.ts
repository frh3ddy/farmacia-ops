import { Injectable } from '@nestjs/common';

@Injectable()
export class WebhookTestService {
  private isPaused = false;

  pause(): void {
    this.isPaused = true;
  }

  resume(): void {
    this.isPaused = false;
  }

  getStatus(): { paused: boolean } {
    return { paused: this.isPaused };
  }

  isWebhookPaused(): boolean {
    return this.isPaused;
  }
}

