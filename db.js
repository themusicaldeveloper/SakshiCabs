const { Pool } = require("pg");

let pool;

if (process.env.DB_ADAPTER === "memory") {
  const { newDb } = require("pg-mem");
  const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memoryDb.adapters.createPg();
  pool = new adapter.Pool();
} else {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required. See .env.example for PostgreSQL setup.");
  }

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
  });
}

module.exports = {
  pool,
  query(text, params) {
    return pool.query(text, params);
  },
};
