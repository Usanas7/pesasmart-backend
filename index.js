require("dotenv").config();
const express = require("express");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const cors = require("cors");
app.use(cors());
const bcrypt = require("bcryptjs");

const pool = require("./db");

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("PesaSmart API is running");
});

app.get("/db-check", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ status: "connected", time: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.post("/api/signup", async (req, res) => {
  const { fullName, phoneNumber, pin } = req.body;
  try {
    const hashedPin = await bcrypt.hash(pin, 10);
    const result = await pool.query(
      "INSERT INTO users (full_name, phone_number, pin) VALUES ($1, $2, $3) RETURNING user_id, full_name, phone_number",
      [fullName, phoneNumber, hashedPin]
    );
    res.status(201).json({ status: "success", user: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ status: "error", message: "Phone number already registered" });
    }
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.post("/api/login", async (req, res) => {
  const { phoneNumber, pin } = req.body;
  try {
    const result = await pool.query("SELECT * FROM users WHERE phone_number = $1", [phoneNumber]);
    if (result.rows.length === 0) {
      return res.status(401).json({ status: "error", message: "Invalid phone number or PIN" });
    }
    const user = result.rows[0];
    const match = await bcrypt.compare(pin, user.pin);
    if (!match) {
      return res.status(401).json({ status: "error", message: "Invalid phone number or PIN" });
    }
    res.json({ status: "success", user: { user_id: user.user_id, full_name: user.full_name, phone_number: user.phone_number } });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// USSD endpoint — the member-facing menu
app.post("/ussd", (req, res) => {
  const { text } = req.body; // accumulates the user's choices, separated by *
  let response = "";

  if (text === "") {
    response = `CON Welcome to PesaSmart
1. View rotation status
2. Raise a dispute
3. Member changes`;
  } else if (text === "1") {
    response = `END Group: Kimironko Traders
Your position: 3 of 10
Next payout: Member 4 (this week)
Your contribution: Paid`;
  } else if (text === "2") {
    response = `CON Raise a dispute
Enter the week number you are disputing:`;
  } else if (text.startsWith("2*")) {
    const week = text.split("*")[1];
    response = `END Dispute submitted for week ${week}.
Your group organiser has been notified.`;
  } else if (text === "3") {
    response = `CON Member changes
1. Request to exit group
2. Update phone number`;
  } else if (text === "3*1") {
    response = `END Your exit request has been sent to the group for approval.`;
  } else if (text === "3*2") {
    response = `CON Enter your new phone number:`;
  } else if (text.startsWith("3*2*")) {
    response = `END Your phone number update request has been sent.`;
  } else {
    response = `END Invalid choice. Please try again.`;
  }

  res.set("Content-Type", "text/plain");
  res.send(response);
});

// Create a new Ikimina group
app.post("/api/groups", async (req, res) => {
  const { name, contributionAmount, frequency, cycleLength, createdBy } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO ikimina_groups (name, contribution_amount, frequency, cycle_length, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [name, contributionAmount, frequency, cycleLength, createdBy]
    );
    res.status(201).json({ status: "success", group: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// List all groups created by an organiser
app.get("/api/groups", async (req, res) => {
  const { createdBy } = req.query;
  try {
    const result = await pool.query(
      "SELECT * FROM ikimina_groups WHERE created_by = $1 ORDER BY created_at DESC",
      [createdBy]
    );
    res.json({ status: "success", groups: result.rows });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`PesaSmart backend listening on port ${PORT}`);
});