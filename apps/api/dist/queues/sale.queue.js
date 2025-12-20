"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SaleQueue = void 0;
const common_1 = require("@nestjs/common");
const bullmq_1 = require("bullmq");
const ioredis_1 = __importDefault(require("ioredis"));
let SaleQueue = class SaleQueue {
    constructor() {
        const connection = new ioredis_1.default(process.env.REDIS_URL);
        this.queue = new bullmq_1.Queue('sales', {
            connection,
            defaultJobOptions: {
                attempts: 5,
                backoff: { type: 'exponential', delay: 5000 },
                removeOnComplete: true,
            },
        });
    }
    async enqueue(event) {
        await this.queue.add('process-sale', {
            squareEventId: event.event_id,
            payload: event.data,
        }, {
            jobId: event.event_id, // ⬅️ idempotency
        });
    }
};
exports.SaleQueue = SaleQueue;
exports.SaleQueue = SaleQueue = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [])
], SaleQueue);
