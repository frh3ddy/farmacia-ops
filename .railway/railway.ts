import { database, defineRailway, github, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const farmaciaOps = github("frh3ddy/farmacia-ops", { branch: "main", checkSuites: false, rootDirectory: "." });

  // Images pinned to what production runs: the postgres()/redis() helpers
  // default to the SDK's current image (postgres:18 in 3.16.0), and a major
  // Postgres bump can't start on the existing data directory.
  const Redis = database("Redis", "redis", { image: "redis:8.2.9", region: "us-west2" });
  Redis.deploy = { startCommand: "/bin/sh -c \"rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --dir $RAILWAY_VOLUME_MOUNT_PATH\"" };
  Redis.networking = { privateNetworkEndpoint: "redis", tcpProxies: { "6379": {} } };
  const Postgres = database("Postgres", "postgres", { image: "ghcr.io/railwayapp-templates/postgres-ssl:17", region: "us-west2" });
  Postgres.networking = { privateNetworkEndpoint: "postgres", tcpProxies: { "5432": {} } };
  const redisVolume = volume("redis-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-west2", sizeMB: 500 });
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-west2", sizeMB: 500 });
  const api = service("api", {
    source: farmaciaOps,
    build: { buildCommand: "npm run build:web && npm run build:api", buildEnvironment: "V3", builder: "RAILPACK", watchPatterns: ["/apps/api/**", "/apps/web/**"] },
    start: "npm run start:api",
    replicas: { "us-west2": 1 },
  });
  const worker = service("worker", {
    source: farmaciaOps,
    build: { buildCommand: "npm run build:worker", buildEnvironment: "V3", builder: "RAILPACK", watchPatterns: ["/apps/worker/**", "/package.json", "/package-lock.json"] },
    start: "npm run start:worker",
    replicas: { "us-west2": 1 },
    networking: { privateNetworkEndpoint: "giving-creation" },
  });

  return project("Farmacia", {
    variables: { managed: false },
    resources: [api, worker, Redis, Postgres, redisVolume, postgresVolume],
  });
});
