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

// Helper: find a member (and their group) by phone number, matching on the last 9 digits
async function findMembershipByPhone(phoneNumber) {
  const last9 = (phoneNumber || "").replace(/\D/g, "").slice(-9);
  const result = await pool.query(
    `SELECT m.member_id, m.rotation_order, m.contribution_status, m.payout_received,
            g.group_id, g.name AS group_name, g.cycle_length, g.contribution_amount,
            u.full_name
     FROM ikimina_members m
     JOIN ikimina_groups g ON g.group_id = m.group_id
     JOIN users u ON u.user_id = m.user_id
     WHERE RIGHT(REGEXP_REPLACE(u.phone_number, '\\D', '', 'g'), 9) = $1
     ORDER BY m.member_id
     LIMIT 1`,
    [last9]
  );
  return result.rows[0] || null;
}

// USSD member menu
app.post("/ussd", async (req, res) => {
  const { text, phoneNumber } = req.body;
  let response = "";

  if (text === "") {
    response = `CON Welcome to PesaSmart
1. View rotation status
2. Raise a dispute
3. Member changes`;
  } else if (text === "1") {
    try {
      const m = await findMembershipByPhone(phoneNumber);
      if (!m) {
        response = `END You are not registered in any PesaSmart group. Please ask your group organiser to add your number.`;
      } else {
        const nextRes = await pool.query(
          `SELECT u.full_name, mm.rotation_order,
                  (g.start_date + ((mm.rotation_order - 1) *
                    CASE WHEN g.frequency = 'Weekly' THEN INTERVAL '1 week'
                         ELSE INTERVAL '1 month' END))::date AS payout_date
           FROM ikimina_members mm
           JOIN users u ON u.user_id = mm.user_id
           JOIN ikimina_groups g ON g.group_id = mm.group_id
           WHERE mm.group_id = $1 AND mm.payout_received = FALSE
           ORDER BY mm.rotation_order
           LIMIT 1`,
          [m.group_id]
        );
        const next = nextRes.rows[0];
        let nextLine;
        if (!next) {
          nextLine = `Next payout: cycle complete`;
        } else if (next.payout_date) {
          const d = new Date(next.payout_date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
          nextLine = `Next payout: ${next.full_name} on ${d}`;
        } else {
          nextLine = `Next payout: ${next.full_name} (position ${next.rotation_order})`;
        }
        response = `END ${m.group_name}
Your position: ${m.rotation_order} of ${m.cycle_length}
${nextLine}
Your contribution: ${m.contribution_status}`;
      }
    } catch (err) {
      response = `END Sorry, something went wrong. Please try again later.`;
    }
  
} else if (text === "2") {
    response = `CON Raise a dispute
Enter the week number you are disputing:`;
  } else if (text.startsWith("2*")) {
    const week = text.split("*")[1];
    try {
      const m = await findMembershipByPhone(phoneNumber);
      if (!m) {
        response = `END You are not registered in any PesaSmart group.`;
      } else if (!/^\d+$/.test(week)) {
        response = `END Invalid week number. Please try again and enter digits only.`;
      } else {
        await pool.query(
          "INSERT INTO contribution_disputes (group_id, member_id, disputed_week) VALUES ($1, $2, $3)",
          [m.group_id, m.member_id, parseInt(week, 10)]
        );
        response = `END Dispute submitted for week ${week}.
Your group organiser has been notified.`;
      }
    } catch (err) {
      response = `END Sorry, something went wrong. Please try again later.`;
    }
  
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
  const { name, contributionAmount, frequency, cycleLength, startDate, createdBy } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO ikimina_groups (name, contribution_amount, frequency, cycle_length, start_date, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
      [name, contributionAmount, frequency, cycleLength, startDate, createdBy]
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

// Update a member's contribution status (organiser confirms payment)
app.patch("/api/members/:memberId/contribution", async (req, res) => {
  const { memberId } = req.params;
  const { status } = req.body; // "paid" or "pending"
  try {
    const result = await pool.query(
      "UPDATE ikimina_members SET contribution_status = $1 WHERE member_id = $2 RETURNING *",
      [status, memberId]
    );
    if (result.rows.length === 0) return res.status(404).json({ status: "error", message: "Member not found" });
    res.json({ status: "success", member: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// List disputes for a group
app.get("/api/groups/:groupId/disputes", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.dispute_id, d.disputed_week, d.status, d.raised_at, d.resolved_at,
              u.full_name, u.phone_number
       FROM contribution_disputes d
       JOIN ikimina_members m ON m.member_id = d.member_id
       JOIN users u ON u.user_id = m.user_id
       WHERE d.group_id = $1
       ORDER BY d.raised_at DESC`,
      [req.params.groupId]
    );
    res.json({ status: "success", disputes: result.rows });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// Resolve (or reopen) a dispute
app.patch("/api/disputes/:disputeId", async (req, res) => {
  const { disputeId } = req.params;
  const { status } = req.body; // "resolved" or "open"
  try {
    const resolvedAt = status === "resolved" ? "NOW()" : "NULL";
    const result = await pool.query(
      `UPDATE contribution_disputes SET status = $1, resolved_at = ${resolvedAt} WHERE dispute_id = $2 RETURNING *`,
      [status, disputeId]
    );
    if (result.rows.length === 0) return res.status(404).json({ status: "error", message: "Dispute not found" });
    res.json({ status: "success", dispute: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`PesaSmart backend listening on port ${PORT}`);
});