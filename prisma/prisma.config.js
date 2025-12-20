"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = require("dotenv");
const config_1 = require("prisma/config");
// Load environment variables from .env file BEFORE using env() helper
(0, dotenv_1.config)();
exports.default = (0, config_1.defineConfig)({
    schema: 'schema.prisma',
    migrations: {
        path: 'migrations',
    },
    datasource: {
        url: (0, config_1.env)('DATABASE_URL'),
    },
});
