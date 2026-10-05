const fs = require("fs/promises");
const path = require("path");
const { newDb } = require("pg-mem");

const tableNames = [
  "organizations",
  "users",
  "vehicles",
  "bookings",
  "notifications",
  "booking_cancellation_requests",
  "booking_schedule_conflicts",
];

const foreignKeys = {
  users: { organization_id: "organizations" },
  vehicles: { organization_id: "organizations" },
  bookings: { organization_id: "organizations", vehicle_id: "vehicles", driver_id: "users" },
  notifications: { organization_id: "organizations", recipient_user_id: "users", booking_id: "bookings" },
  booking_cancellation_requests: { organization_id: "organizations", booking_id: "bookings" },
  booking_schedule_conflicts: {
    organization_id: "organizations",
    booking_id: "bookings",
    conflicting_booking_id: "bookings",
  },
};

const dataFile = path.resolve(process.env.DATA_FILE || path.join(__dirname, "data", "taxi-booking.json"));
const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
const adapter = memoryDb.adapters.createPg();
const rawPool = new adapter.Pool();
let initialized = false;
let writeQueue = Promise.resolve();

function isMutation(text) {
  return /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE|REPLACE)\b/i.test(text);
}

async function readSnapshot() {
  try {
    const snapshot = JSON.parse(await fs.readFile(dataFile, "utf8"));
    if (snapshot.version !== 1 || !snapshot.tables || typeof snapshot.tables !== "object") {
      throw new Error(`Unsupported or invalid JSON dataset in ${dataFile}.`);
    }
    for (const tableName of tableNames) {
      if (!Array.isArray(snapshot.tables[tableName])) {
        throw new Error(`Invalid JSON dataset in ${dataFile}: "${tableName}" must be an array.`);
      }
    }
    return snapshot;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeSnapshot() {
  const tables = {};
  for (const tableName of tableNames) {
    const result = await rawPool.query(`SELECT * FROM ${tableName} ORDER BY id`);
    tables[tableName] = result.rows;
  }

  const temporaryFile = `${dataFile}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  await fs.writeFile(temporaryFile, `${JSON.stringify({ version: 1, tables }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryFile, dataFile);
}

function persist() {
  const nextWrite = writeQueue.then(writeSnapshot);
  writeQueue = nextWrite.catch(() => {});
  return nextWrite;
}

async function restoreSnapshot(snapshot) {
  const ids = Object.fromEntries(tableNames.map((tableName) => [tableName, new Map()]));

  for (const tableName of tableNames) {
    const rows = [...snapshot.tables[tableName]].sort((a, b) => Number(a.id) - Number(b.id));
    for (const savedRow of rows) {
      const row = { ...savedRow };
      const oldId = row.id;
      delete row.id;

      for (const [column, parentTable] of Object.entries(foreignKeys[tableName] || {})) {
        if (row[column] !== null && row[column] !== undefined) {
          const newParentId = ids[parentTable].get(String(row[column]));
          if (newParentId === undefined) {
            throw new Error(`Invalid JSON dataset in ${dataFile}: missing ${parentTable} record ${row[column]}.`);
          }
          row[column] = newParentId;
        }
      }

      const columns = Object.keys(row);
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
      const result = await rawPool.query(
        `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders}) RETURNING id`,
        columns.map((column) => row[column]),
      );
      ids[tableName].set(String(oldId), result.rows[0].id);
    }
  }
}

async function initialize(schema) {
  await rawPool.query(schema);
  const snapshot = await readSnapshot();
  if (snapshot) await restoreSnapshot(snapshot);
  initialized = true;
}

async function query(text, params) {
  const result = await rawPool.query(text, params);
  if (initialized && isMutation(text)) await persist();
  return result;
}

const pool = {
  query,
  async connect() {
    const client = await rawPool.connect();
    let inTransaction = false;
    return {
      async query(text, params) {
        const command = String(text).trim().toUpperCase();
        const result = await client.query(text, params);
        if (command === "BEGIN") {
          inTransaction = true;
        } else if (command === "COMMIT") {
          inTransaction = false;
          if (initialized) await persist();
        } else if (command === "ROLLBACK") {
          inTransaction = false;
        } else if (initialized && !inTransaction && isMutation(text)) {
          await persist();
        }
        return result;
      },
      release() {
        client.release();
      },
    };
  },
};

module.exports = { initialize, pool, query };
