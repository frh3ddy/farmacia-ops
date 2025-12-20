"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const port = process.env.PORT || 3000;
console.log(`🚀 Starting Farmacia Ops API on port ${port}...`);
// Basic HTTP server for now
const http_1 = require("http");
const server = (0, http_1.createServer)((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        message: 'Farmacia Ops API',
        status: 'running',
        timestamp: new Date().toISOString()
    }));
});
server.listen(port, () => {
    console.log(`✅ API server listening on port ${port}`);
});
// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Shutting down API server...');
    server.close(() => {
        process.exit(0);
    });
});
process.on('SIGINT', () => {
    console.log('🛑 Shutting down API server...');
    server.close(() => {
        process.exit(0);
    });
});
