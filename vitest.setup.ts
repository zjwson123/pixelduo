process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://pixelduo:pixelduo@localhost:5432/pixelduo_test";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
