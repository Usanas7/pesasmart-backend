const { Pool } = require("pg");

console.log("DB host:", (process.env.DATABASE_URL || "NOT SET").split("@")[1]?.split("/")[0] || "could not parse host");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon requires SSL
});

module.exports = pool;