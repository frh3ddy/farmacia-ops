"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runConnectionTests = runConnectionTests;
const ioredis_1 = __importDefault(require("ioredis"));
const bullmq_1 = require("bullmq");
async function measureTime(fn) {
    const start = Date.now();
    const result = await fn();
    const duration = Date.now() - start;
    return { result, duration };
}
function getRedisConfig() {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
        throw new Error('REDIS_URL environment variable is not set');
    }
    const url = new URL(redisUrl);
    return {
        host: url.hostname,
        port: parseInt(url.port || '6379', 10),
        password: url.password || undefined,
        db: url.pathname ? parseInt(url.pathname.slice(1), 10) : 0,
    };
}
async function testRedisConnection() {
    const config = getRedisConfig();
    const client = new ioredis_1.default(config);
    try {
        const result = await client.ping();
        await client.quit();
        return result === 'PONG';
    }
    catch (error) {
        await client.quit().catch(() => { });
        throw error;
    }
}
async function testBullMQConnection(queueName = 'test-queue') {
    const config = getRedisConfig();
    let queue = null;
    try {
        queue = new bullmq_1.Queue(queueName, {
            connection: {
                host: config.host,
                port: config.port,
                password: config.password,
                db: config.db,
            },
        });
        const job = await queue.add('test-job', { test: true });
        await new Promise(resolve => setTimeout(resolve, 100));
        const jobState = await job.getState();
        await queue.obliterate({ force: true });
        await queue.close();
        return jobState !== undefined;
    }
    catch (error) {
        if (queue) {
            try {
                await queue.obliterate({ force: true });
                await queue.close();
            }
            catch (cleanupError) {
                // Ignore cleanup errors
            }
        }
        throw error;
    }
}
/**
 * Test Redis connection
 */
async function testRedis() {
    try {
        const { result, duration } = await measureTime(async () => {
            return await testRedisConnection();
        });
        return {
            service: 'Redis',
            success: result,
            message: result ? 'Redis connection successful' : 'Redis connection failed',
            duration,
        };
    }
    catch (error) {
        return {
            service: 'Redis',
            success: false,
            message: 'Redis connection failed',
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}
/**
 * Test BullMQ connection
 */
async function testBullMQ() {
    try {
        const { result, duration } = await measureTime(async () => {
            return await testBullMQConnection('connection-test-queue');
        });
        return {
            service: 'BullMQ',
            success: result,
            message: result ? 'BullMQ connection successful' : 'BullMQ connection failed',
            duration,
        };
    }
    catch (error) {
        return {
            service: 'BullMQ',
            success: false,
            message: 'BullMQ connection failed',
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}
/**
 * Run all connection tests
 */
async function runConnectionTests() {
    console.log('🔍 Starting connection tests...\n');
    const results = [];
    // Test Redis
    console.log('Testing Redis connection...');
    const redisResult = await testRedis();
    results.push(redisResult);
    console.log(`${redisResult.success ? '✅' : '❌'} ${redisResult.service}: ${redisResult.message}${redisResult.duration ? ` (${redisResult.duration}ms)` : ''}`);
    if (redisResult.error) {
        console.log(`   Error: ${redisResult.error}\n`);
    }
    else {
        console.log();
    }
    // Test BullMQ (only if Redis succeeded)
    if (redisResult.success) {
        console.log('Testing BullMQ connection...');
        const bullmqResult = await testBullMQ();
        results.push(bullmqResult);
        console.log(`${bullmqResult.success ? '✅' : '❌'} ${bullmqResult.service}: ${bullmqResult.message}${bullmqResult.duration ? ` (${bullmqResult.duration}ms)` : ''}`);
        if (bullmqResult.error) {
            console.log(`   Error: ${bullmqResult.error}\n`);
        }
        else {
            console.log();
        }
    }
    else {
        console.log('⏭️  Skipping BullMQ test (Redis connection failed)\n');
        results.push({
            service: 'BullMQ',
            success: false,
            message: 'Skipped - Redis connection failed',
        });
    }
    // Summary
    console.log('📊 Test Summary:');
    const allPassed = results.every(r => r.success);
    results.forEach(result => {
        const status = result.success ? '✅ PASS' : '❌ FAIL';
        console.log(`   ${status} - ${result.service}`);
    });
    console.log(`\n${allPassed ? '✅ All tests passed!' : '❌ Some tests failed'}\n`);
    return results;
}
/**
 * Main execution
 */
async function main() {
    try {
        const results = await runConnectionTests();
        const allPassed = results.every(r => r.success);
        process.exit(allPassed ? 0 : 1);
    }
    catch (error) {
        console.error('❌ Fatal error during connection tests:', error);
        process.exit(1);
    }
}
// Run if executed directly
if (require.main === module) {
    main();
}
