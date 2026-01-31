import "reflect-metadata";
import { config } from "dotenv";
import { resolve, join } from "path";
import { NestFactory } from "@nestjs/core";
import { INestApplication } from "@nestjs/common";
import { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import * as express from "express";

// Load .env file from project root
// __dirname in compiled code will be apps/api/dist, so we need to go up 3 levels to reach root
const envPath = resolve(__dirname, "../../../.env");
const result = config({ path: envPath });
if (result.error && !process.env.DATABASE_URL) {
  console.warn(
    `Warning: Could not load .env from ${envPath}:`,
    result.error.message
  );
  console.warn("Trying alternative path...");
  // Fallback: try loading from current working directory
  config();
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is not set");
}

const port = process.env.PORT || 3000;

let app: NestExpressApplication;

async function bootstrap() {
  const isLocal = process.env.NODE_ENV !== "production";
  console.log(`🚀 Starting Farmacia Ops API on port ${port}...`);

  // Run Prisma migrations before starting the app (ensures migrations run in Railway)
  try {
    const { execSync } = require("child_process");
    const { resolve } = require("path");
    if (!isLocal) {
      console.log("🔄 Running database migrations...");

      // Ensure we're in the project root for Prisma commands
      const projectRoot = resolve(__dirname, "../../..");
      execSync("npx prisma migrate deploy", {
        stdio: "inherit",
        env: { ...process.env, DATABASE_URL: connectionString },
        cwd: projectRoot,
      });
      console.log("✅ Database migrations completed");
    } else {
      console.log(
        '🛠️ Skipping auto-migrations. Run "npx prisma migrate dev" manually.'
      );
    }
  } catch (error) {
    console.error("❌ Migration error:", error);
    // In production, fail fast if migrations fail
    if (process.env.NODE_ENV === "production") {
      throw error;
    }
    // In development, continue (migrations might have already run)
    console.warn("⚠️ Continuing despite migration error (dev mode)");
  }

  // Pass the NestExpressApplication type generic
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // This is crucial: it preserves the raw buffer for signature verification
    rawBody: true,
  });

  // Apply JSON parser for all other routes
  // app.use(express.json());

  // Configure CORS
  app.enableCors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  });

  // Serve static files from public directory
  const publicPath = join(__dirname, "..", "public");
  app.useStaticAssets(publicPath, {
    index: "index.html",
  });

  // Fallback to index.html for non-API routes (client-side routing)
  app.use(
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      const path = req.path;
      // List of API route prefixes that should NOT serve static HTML
      const apiPrefixes = [
        "/api",
        "/admin",
        "/webhooks",
        "/locations",
        "/auth",
        "/employees",
        "/inventory",
        "/expenses",
      ];
      const isApiRoute = apiPrefixes.some(prefix => path.startsWith(prefix));
      
      if (
        !isApiRoute &&
        path !== "/" &&
        !path.includes(".")
      ) {
        res.sendFile(join(publicPath, "index.html"));
      } else {
        next();
      }
    }
  );

  await app.listen(port);
  console.log(`✅ API server listening on port ${port}`);
  console.log(`📁 Serving static files from: ${publicPath}`);
}

// Graceful shutdown
async function gracefulShutdown() {
  console.log("🛑 Shutting down API server...");
  if (app) {
    await app.close();
    console.log("✅ NestJS application closed");
  }
  process.exit(0);
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

bootstrap().catch((error) => {
  console.error("Failed to start application:", error);
  process.exit(1);
});
