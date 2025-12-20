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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SquareWebhookController = void 0;
const common_1 = require("@nestjs/common");
const crypto_1 = __importDefault(require("crypto"));
const sale_queue_1 = require("../queues/sale.queue");
let SquareWebhookController = class SquareWebhookController {
    constructor(saleQueue) {
        this.saleQueue = saleQueue;
    }
    async handle(req, res, signature) {
        const body = JSON.stringify(req.body);
        if (!this.verifySignature(body, signature)) {
            return res.status(common_1.HttpStatus.UNAUTHORIZED).send('Invalid signature');
        }
        const event = req.body;
        // Only process relevant events
        if (event.type !== 'payment.created') {
            return res.status(common_1.HttpStatus.OK).send('Ignored');
        }
        await this.saleQueue.enqueue(event);
        return res.status(common_1.HttpStatus.OK).send('Accepted');
    }
    verifySignature(body, signature) {
        const hmac = crypto_1.default
            .createHmac('sha256', process.env.SQUARE_WEBHOOK_SECRET)
            .update(body)
            .digest('base64');
        return hmac === signature;
    }
};
exports.SquareWebhookController = SquareWebhookController;
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Res)()),
    __param(2, (0, common_1.Headers)('x-square-signature')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String]),
    __metadata("design:returntype", Promise)
], SquareWebhookController.prototype, "handle", null);
exports.SquareWebhookController = SquareWebhookController = __decorate([
    (0, common_1.Controller)('webhooks/square'),
    __metadata("design:paramtypes", [sale_queue_1.SaleQueue])
], SquareWebhookController);
