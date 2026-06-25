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

// Get a single group
app.get("/api/groups/:groupId", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM ikimina_groups WHERE group_id = $1", [req.params.groupId]);
    if (result.rows.length === 0) return res.status(404).json({ status: "error", message: "Group not found" });
    res.json({ status: "success", group: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// List members of a group (in rotation order)
app.get("/api/groups/:groupId/members", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.member_id, m.rotation_order, m.contribution_status, m.payout_received, m.status,
              u.full_name, u.phone_number
       FROM ikimina_members m
       JOIN users u ON u.user_id = m.user_id
       WHERE m.group_id = $1
       ORDER BY m.rotation_order`,
      [req.params.groupId]
    );
    res.json({ status: "success", members: result.rows });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// Add a member to a group
app.post("/api/groups/:groupId/members", async (req, res) => {
  const { groupId } = req.params;
  const { fullName, phoneNumber } = req.body;
  try {
    // Find the person by phone, or create them (members don't need a PIN)
    let userResult = await pool.query("SELECT user_id FROM users WHERE phone_number = $1", [phoneNumber]);
    let userId;
    if (userResult.rows.length > 0) {
      userId = userResult.rows[0].user_id;
    } else {
      const insertUser = await pool.query(
        "INSERT INTO users (full_name, phone_number) VALUES ($1, $2) RETURNING user_id",
        [fullName, phoneNumber]
      );
      userId = insertUser.rows[0].user_id;
    }

    // Prevent adding the same person to this group twice
    const existing = await pool.query(
      "SELECT member_id FROM ikimina_members WHERE user_id = $1 AND group_id = $2",
      [userId, groupId]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ status: "error", message: "This phone number is already a member of this group" });
    }

    // Assign the next rotation position
    const orderResult = await pool.query(
      "SELECT COALESCE(MAX(rotation_order), 0) + 1 AS next FROM ikimina_members WHERE group_id = $1",
      [groupId]
    );
    const nextOrder = orderResult.rows[0].next;

    const result = await pool.query(
      "INSERT INTO ikimina_members (user_id, group_id, rotation_order) VALUES ($1, $2, $3) RETURNING *",
      [userId, groupId, nextOrder]
    );
    res.status(201).json({ status: "success", member: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`PesaSmart backend listening on port ${PORT}`);
});