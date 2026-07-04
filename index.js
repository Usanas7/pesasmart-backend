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

  const parts = text === "" ? [] : text.split("*");
  const last = parts[parts.length - 1];
  const section = parts[0]; // "1" group status, "2" dispute, "3" member changes

  const mainMenu = `CON Welcome to PesaSmart
1. Group Status
2. Raise a dispute
3. Member changes`;

  // Reusable Group Status menu (with live header)
  async function groupStatusMenu(m) {
    const g = await pool.query(
      `SELECT group_id, name, cycle_length, frequency, start_date FROM ikimina_groups WHERE group_id = $1`,
      [m.group_id]
    );
    const info = await weekInfo(g.rows[0]);
    return `CON ${g.rows[0].name}
${info.header}
1. My status
2. Who has paid
3. Rotation order
4. Open disputes
0. Back`;
  }

  try {
    // ===== MAIN MENU =====
    if (text === "") {
      response = mainMenu;

    // ===== UNIVERSAL BACK (last key is 0) =====
    // Pressing 0 always steps back, decided by section. Checked before any
    // input parsing so it can never be read as a week number or transaction ID.
    } else if (last === "0") {
      const m = await findMembershipByPhone(phoneNumber);
      if (section === "1" && parts.length === 2) {
        // 1*0 -> back to main menu from the group status menu
        response = mainMenu;
      } else if (section === "1" && parts.length >= 3) {
        // inside a group-status screen -> back to the group status menu
        response = m ? await groupStatusMenu(m) : `END You are not registered in any PesaSmart group.`;
      } else {
        // 2*0, 3*0, etc. -> back to main menu
        response = mainMenu;
      }

    // ===== 1. GROUP STATUS =====
    } else if (text === "1") {
      const m = await findMembershipByPhone(phoneNumber);
      response = m
        ? await groupStatusMenu(m)
        : `END You are not registered in any PesaSmart group. Please ask your group organiser to add your number.`;

    } else if (section === "1" && last === "1" && parts.length > 1) {
      // My status
      const m = await findMembershipByPhone(phoneNumber);
      if (!m) {
        response = `END You are not registered in any PesaSmart group.`;
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
          nextLine = `Next payout: ${shortName(next.full_name)} on ${d}`;
        } else {
          nextLine = `Next payout: ${shortName(next.full_name)}`;
        }
        response = `CON Your position: ${m.rotation_order} of ${m.cycle_length}
${nextLine}
Your contribution: ${m.contribution_status}
0. Back`;
      }

    } else if (section === "1" && last === "2") {
      // Who has paid
      const m = await findMembershipByPhone(phoneNumber);
      if (!m) {
        response = `END You are not registered in any PesaSmart group.`;
      } else {
        const rows = await pool.query(
          `SELECT u.full_name, mm.contribution_status
           FROM ikimina_members mm
           JOIN users u ON u.user_id = mm.user_id
           WHERE mm.group_id = $1 AND mm.status = 'active'
           ORDER BY mm.rotation_order`,
          [m.group_id]
        );
        const paid = rows.rows.filter((r) => r.contribution_status === "paid").length;
        const lines = rows.rows.map((r) => `${r.contribution_status === "paid" ? "+" : "-"} ${shortName(r.full_name)}`);
        response = `CON Contributions ${paid}/${rows.rows.length}
${lines.join("\n")}
0. Back`;
      }

    } else if (section === "1" && last === "3") {
      // Rotation order
      const m = await findMembershipByPhone(phoneNumber);
      if (!m) {
        response = `END You are not registered in any PesaSmart group.`;
      } else {
        const rows = await pool.query(
          `SELECT u.full_name, mm.rotation_order, mm.payout_received
           FROM ikimina_members mm
           JOIN users u ON u.user_id = mm.user_id
           WHERE mm.group_id = $1 AND mm.status = 'active'
           ORDER BY mm.rotation_order`,
          [m.group_id]
        );
        const lines = rows.rows.map((r) => `${r.rotation_order}. ${shortName(r.full_name)}${r.payout_received ? " (paid out)" : ""}`);
        response = `CON Rotation order
${lines.join("\n")}
0. Back`;
      }

    } else if (section === "1" && last === "4") {
      // Open disputes count
      const m = await findMembershipByPhone(phoneNumber);
      if (!m) {
        response = `END You are not registered in any PesaSmart group.`;
      } else {
        const countRes = await pool.query(
          "SELECT COUNT(*) FROM contribution_disputes WHERE group_id = $1 AND status = 'open'",
          [m.group_id]
        );
        response = `CON Open disputes in this cycle: ${countRes.rows[0].count}
0. Back`;
      }

    // ===== 2. RAISE A DISPUTE =====
    } else if (text === "2") {
      response = `CON Raise a dispute
Enter the week number you are disputing:
0. Back`;

    } else if (section === "2" && parts.length === 2) {
      // Entered the week; ask for transaction ID
      const week = parts[1];
      if (!/^\d+$/.test(week)) {
        response = `END Invalid week number. Please redial and enter digits only.`;
      } else {
        response = `CON Week ${week} dispute
Enter your MoMo transaction ID (from your SMS receipt):`;
      }

    } else if (section === "2" && parts.length === 3) {
      // Entered week + transaction ID; record dispute
      const week = parts[1];
      const txid = parts[2];
      const m = await findMembershipByPhone(phoneNumber);
      if (!m) {
        response = `END You are not registered in any PesaSmart group.`;
      } else if (!/^\d+$/.test(week)) {
        response = `END Invalid week number. Please redial and try again.`;
      } else if (!txid || txid.length < 3) {
        response = `END Invalid transaction ID. Please redial and try again.`;
      } else {
        const ins = await pool.query(
          "INSERT INTO contribution_disputes (group_id, member_id, disputed_week, momo_txid) VALUES ($1, $2, $3, $4) RETURNING dispute_id",
          [m.group_id, m.member_id, parseInt(week, 10), txid]
        );
        const ref = String(ins.rows[0].dispute_id).padStart(4, "0");
        response = `END Dispute REF#${ref} raised for Week ${week}.
Your group organiser has been notified.
Note: this records your transaction ID; it is not independent verification.`;
      }

    // ===== 3. MEMBER CHANGES =====
    } else if (text === "3") {
      response = `CON Member changes
1. Request to exit group
2. Update phone number
0. Back`;

    } else if (text === "3*1") {
      const m = await findMembershipByPhone(phoneNumber);
      if (!m) {
        response = `END You are not registered in any PesaSmart group.`;
      } else {
        await pool.query(
          "INSERT INTO membership_changes (group_id, affected_user, change_type) VALUES ($1, $2, 'exit')",
          [m.group_id, m.user_id]
        );
        response = `END Your exit request has been sent to the group for approval.`;
      }

    } else if (text === "3*2") {
      response = `CON Enter your new phone number:`;

    } else if (section === "3" && parts.length === 3 && parts[1] === "2") {
      // Entered new phone number
      const newPhone = parts[2];
      const m = await findMembershipByPhone(phoneNumber);
      if (!m) {
        response = `END You are not registered in any PesaSmart group.`;
      } else if (!/^\d{6,15}$/.test(newPhone)) {
        response = `END Invalid phone number. Please redial and enter digits only.`;
      } else {
        await pool.query(
          "INSERT INTO membership_changes (group_id, affected_user, change_type, details) VALUES ($1, $2, 'phone_update', $3)",
          [m.group_id, m.user_id, newPhone]
        );
        response = `END Your phone number update request has been sent.`;
      }

    // ===== FALLBACK =====
    } else {
      response = `END Invalid choice. Please try again.`;
    }
  } catch (err) {
    response = `END Sorry, something went wrong. Please try again later.`;
  }

  res.set("Content-Type", "text/plain");
  res.send(response);
});

// Shorten a full name for USSD screens: "Niyonzima Christine" -> "Niyonzima C."
function shortName(fullName) {
  const parts = (fullName || "").trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[1][0]}.`;
}
// Work out the current round, deadline, and contributions received from a group's start date
async function weekInfo(group) {
  if (!group || !group.start_date) {
    return { header: "Round -\nDeadline: not set" };
  }
  const start = new Date(group.start_date);
  const today = new Date();
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysElapsed = Math.floor((today - start) / msPerDay);

  const periodDays = group.frequency === "Weekly" ? 7 : 30;
  let round = Math.floor(daysElapsed / periodDays) + 1;
  if (round < 1) round = 1;
  if (round > group.cycle_length) round = group.cycle_length;

  const deadline = new Date(start.getTime() + round * periodDays * msPerDay);
  const dStr = deadline.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

  const paidRes = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE contribution_status = 'paid') AS paid,
            COUNT(*) AS total
     FROM ikimina_members WHERE group_id = $1 AND status = 'active'`,
    [group.group_id]
  );
  const { paid, total } = paidRes.rows[0];

  return {
    header: `Round ${round} of ${group.cycle_length}
Contributions: ${paid}/${total}
Deadline: ${dStr}`,
  };
}

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
`SELECT m.member_id, m.user_id, m.rotation_order, m.contribution_status, m.payout_received,u.full_name, u.phone_number
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
      `SELECT d.dispute_id, d.disputed_week, d.momo_txid, d.status, d.raised_at, d.resolved_at,
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

// List membership change requests for a group
app.get("/api/groups/:groupId/changes", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.change_id, c.change_type, c.status, c.details, c.created_at,
              u.full_name, u.phone_number
       FROM membership_changes c
       JOIN users u ON u.user_id = c.affected_user
       WHERE c.group_id = $1
       ORDER BY c.created_at DESC`,
      [req.params.groupId]
    );
    res.json({ status: "success", changes: result.rows });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// Approve or reject a membership change request
app.patch("/api/changes/:changeId", async (req, res) => {
  const { changeId } = req.params;
  const { decision } = req.body; // "approved" or "rejected"
  try {
    const cRes = await pool.query("SELECT * FROM membership_changes WHERE change_id = $1", [changeId]);
    if (cRes.rows.length === 0) return res.status(404).json({ status: "error", message: "Request not found" });
    const change = cRes.rows[0];

    if (decision === "approved") {
      if (change.change_type === "exit") {
        await pool.query(
          "UPDATE ikimina_members SET status = 'inactive' WHERE user_id = $1 AND group_id = $2",
          [change.affected_user, change.group_id]
        );
      } else if (change.change_type === "phone_update" && change.details) {
        await pool.query(
          "UPDATE users SET phone_number = $1 WHERE user_id = $2",
          [change.details, change.affected_user]
        );
      }
    }

    const result = await pool.query(
      "UPDATE membership_changes SET status = $1 WHERE change_id = $2 RETURNING *",
      [decision, changeId]
    );
    res.json({ status: "success", change: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ status: "error", message: "That phone number is already in use by another user" });
    }
    res.status(500).json({ status: "error", message: err.message });
  }
});

// Send an SMS broadcast to all active members of a group
app.post("/api/groups/:groupId/broadcast", async (req, res) => {
  const { groupId } = req.params;
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ status: "error", message: "Message cannot be empty" });
  }
  try {
    // Collect active members' phone numbers
    const members = await pool.query(
      `SELECT u.user_id, u.phone_number
       FROM ikimina_members m
       JOIN users u ON u.user_id = m.user_id
       WHERE m.group_id = $1 AND m.status = 'active'`,
      [groupId]
    );
    if (members.rows.length === 0) {
      return res.status(400).json({ status: "error", message: "This group has no active members" });
    }

    // Normalise to +250 international format for Africa's Talking
    const recipients = members.rows.map((r) => {
      const last9 = r.phone_number.replace(/\D/g, "").slice(-9);
      return "+250" + last9;
    });

    // Send via Africa's Talking
    const AfricasTalking = require("africastalking")({
      username: process.env.AT_USERNAME,
      apiKey: process.env.AT_API_KEY,
    });
    await AfricasTalking.SMS.send({ to: recipients, message });

    // Log each send in the database
    for (const m of members.rows) {
      await pool.query(
        "INSERT INTO sms_notifications (user_id, message, status) VALUES ($1, $2, 'sent')",
        [m.user_id, message]
      );
    }

    res.json({ status: "success", sentTo: recipients.length });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`PesaSmart backend listening on port ${PORT}`);
});