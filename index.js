require("dotenv").config();
const express = require("express");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const cors = require("cors");
app.use(cors());
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const pool = require("./db");

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "pesasmart-dev-secret-change-me";

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

// Middleware: require a valid login token
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ status: "error", message: "Not authenticated. Please log in." });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ status: "error", message: "Session expired. Please log in again." });
  }
}

app.post("/api/signup", async (req, res) => {
  const { fullName, phoneNumber, pin } = req.body;

  if (!fullName || !fullName.trim()) {
    return res.status(400).json({ status: "error", message: "Full name is required" });
  }
  if (!/^\d{9,15}$/.test((phoneNumber || "").replace(/\D/g, ""))) {
    return res.status(400).json({ status: "error", message: "Enter a valid phone number (digits only)" });
  }
  if (!/^\d{5}$/.test(pin || "")) {
    return res.status(400).json({ status: "error", message: "PIN must be exactly 5 digits" });
  }

  try {
    const hashedPin = await bcrypt.hash(pin, 10);
    const result = await pool.query(
      "INSERT INTO users (full_name, phone_number, pin) VALUES ($1, $2, $3) RETURNING user_id, full_name, phone_number",
      [fullName.trim(), phoneNumber.trim(), hashedPin]
    );
    const user = result.rows[0];
    const token = jwt.sign({ user_id: user.user_id, full_name: user.full_name }, JWT_SECRET, { expiresIn: "7d" });
    res.status(201).json({ status: "success", user, token });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ status: "error", message: "Phone number already registered" });
    }
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.post("/api/login", async (req, res) => {
  const { phoneNumber, pin } = req.body;
  if (!phoneNumber || !pin) {
    return res.status(400).json({ status: "error", message: "Phone number and PIN are required" });
  }
  try {
    const result = await pool.query("SELECT * FROM users WHERE phone_number = $1", [phoneNumber.trim()]);
    if (result.rows.length === 0) {
      return res.status(401).json({ status: "error", message: "Invalid phone number or PIN" });
    }
    const user = result.rows[0];
    if (!user.pin) {
      return res.status(401).json({ status: "error", message: "Invalid phone number or PIN" });
    }
    const match = await bcrypt.compare(pin, user.pin);
    if (!match) {
      return res.status(401).json({ status: "error", message: "Invalid phone number or PIN" });
    }
    const token = jwt.sign({ user_id: user.user_id, full_name: user.full_name }, JWT_SECRET, { expiresIn: "7d" });
    res.json({
      status: "success",
      user: { user_id: user.user_id, full_name: user.full_name, phone_number: user.phone_number },
      token,
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ===========================================================================
// USSD TRANSLATIONS
// en = English (final). rw = Kinyarwanda.
// {placeholders} in braces are filled in by the code - keep them as-is.
// ===========================================================================
const T = {
  en: {
    groupStatus: "Group Status",
    raiseDispute: "Raise a dispute",
    memberChanges: "Member changes",
    myStatus: "My status",
    whoPaid: "Who has paid",
    rotationOrder: "Rotation order",
    openDisputes: "Open disputes",
    back: "0. Back",
    notRegistered: "You are not registered in any PesaSmart group. Please ask your group organiser to add your number.",
    notRegisteredShort: "You are not registered in any PesaSmart group.",
    somethingWrong: "Sorry, something went wrong. Please try again later.",
    invalidChoice: "Invalid choice. Please try again.",
    position: "Position",
    of: "of",
    oweNothing: "You owe: nothing (paid)",
    oweAmount: "You owe: {amount} RWF",
    payoutReceivedYes: "Payout received: yes",
    payoutReceivedNo: "Payout received: not yet",
    turnAlready: "Your turn: already received",
    turnNext: "Your turn: you are next",
    turnRounds: "Your turn: in {n} round(s)",
    nextPayoutName: "Next payout: {name} on {date}",
    nextPayoutNameNoDate: "Next payout: {name}",
    nextPayoutComplete: "Next payout: cycle complete",
    contributions: "Contributions {paid}/{total}",
    paidOut: "(paid out)",
    currentTurn: "<- current turn",
    openDisputesCount: "Open disputes in this cycle: {n}",
    enterWeek: "Enter the week number you are disputing:",
    enterTxid: "Enter your MoMo transaction ID (from your SMS receipt):",
    weekDispute: "Week {week} dispute",
    invalidWeek: "Invalid week number. Please redial and enter digits only.",
    invalidWeekRetry: "Invalid week number. Please redial and try again.",
    invalidTxid: "Invalid transaction ID. Please redial and try again.",
    disputeRaised: "Dispute REF#{ref} raised for Week {week}.\nYour group organiser has been notified.\nNote: this records your transaction ID; it is not independent verification.",
    requestExit: "Request to exit group",
    updatePhone: "Update phone number",
    enterNewPhone: "Enter your new phone number:",
    exitSent: "Your exit request has been sent to the group for approval.",
    invalidPhone: "Invalid phone number. Please redial and enter digits only.",
    phoneSent: "Your phone number update request has been sent.",
  },
  rw: {
    groupStatus: "Imiterere y'itsinda",
    raiseDispute: "Gutanga ikibazo",
    memberChanges: "imihindukire y'umunyamuryango",
    myStatus: "Uko mpagaze",
    whoPaid: "Abishyuye",
    rotationOrder: "Uko bikurikirana",
    openDisputes: "Ibibazo bidakemutse",
    back: "0. Gusubira inyuma",
    notRegistered: "Ntabwo wanditse mu itsinda. Saba umuyobozi w'itsinda kongeramo numero yawe.",
    notRegisteredShort: "Ntabwo wanditse mu itsinda rya PesaSmart.",
    somethingWrong: "Igikorwa nticyibashije gukunda",
    invalidChoice: " Ongera ugerageze.",
    position: "Umwanya",
    of: "wa",
    oweNothing: "umwenda: ntawo (wishyuye)",
    oweAmount: "Ufite umwenda: {amount} RWF",
    payoutReceivedYes: "Wahawe amafaranga: Yego",
    payoutReceivedNo: "Wahawe amafaranga: Oya",
    turnAlready: "Inshuro yawe: wamaze kwishyurwa",
    turnNext: "Inshuro yawe: uzakurikira",
    turnRounds: "Inshuro yawe: mu byiciro {n}",
    nextPayoutName: "Ukurikiyeho kwishyurwa: {name} ku wa {date}",
    nextPayoutNameNoDate: "Uzakurikiraho: {name}",
    nextPayoutComplete: "Uzakurikiraho: uruziga rwarangiye",
    contributions: "Imisanzu {paid}/{total}",
    paidOut: "(yarishyuwe)",
    currentTurn: "<- ugezweho",
    openDisputesCount: "Ibibazo bitaracyemurwa : {n}",
    enterWeek: "Andika icyumweru ufiteho ikibazo:",
    enterTxid: "Andika nomero y'ubwishyu bwa MoMo (iri kuri SMS yawe):",
    weekDispute: "icyumweru ufiteho ikibazo {week}",
    invalidWeek: "Nomero y'icyumweru ntayabonetse. Ongera wandike (imibare gusa).",
    invalidWeekRetry: "Nomero y'icyumweru ntago ariyo. Ongera.",
    invalidTxid: "Nomero y'ubwishyu ntago ariyo. Ongera uhamagare.",
    disputeRaised: "Ikibazo REF#{ref} cyatanzwe ku cyumweru {week}.\nUmuyobozi w'itsinda yamenyeshejwe.\nIcyitonderwa: iyi nomero yanditswe ariko ntabwo yagenzuwe.",
    requestExit: "Gusaba kuva mu itsinda",
    updatePhone: "Guhindura numero ya telefone",
    enterNewPhone: "Andika numero nshya ya telefone:",
    exitSent: "Icyifuzo cyawe cyo kuva mu itsinda cyoherejwe.",
    invalidPhone: "Numero ya telefone ntago ariyo. Ongera uhamagare.",
    phoneSent: "Icyifuzo cyo guhindura numero cyoherejwe.",
  },
};

function fill(str, vars) {
  let out = str;
  for (const k in vars) out = out.split(`{${k}}`).join(vars[k]);
  return out;
}

async function findMembershipByPhone(phoneNumber) {
  const last9 = (phoneNumber || "").replace(/\D/g, "").slice(-9);
  const result = await pool.query(
    `SELECT m.member_id, m.user_id, m.rotation_order, m.contribution_status, m.payout_received,
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

function shortName(fullName) {
  const parts = (fullName || "").trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[1][0]}.`;
}

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

async function sendSms(userId, phoneNumber, message) {
  try {
    const last9 = (phoneNumber || "").replace(/\D/g, "").slice(-9);
    const to = "+250" + last9;
    const AfricasTalking = require("africastalking")({
      username: process.env.AT_USERNAME,
      apiKey: process.env.AT_API_KEY,
    });
    await AfricasTalking.SMS.send({ to: [to], message });
    if (userId) {
      await pool.query(
        "INSERT INTO sms_notifications (user_id, message, status) VALUES ($1, $2, 'sent')",
        [userId, message]
      );
    }
  } catch (err) {
    console.error("SMS failed:", err.message);
    if (userId) {
      try {
        await pool.query(
          "INSERT INTO sms_notifications (user_id, message, status) VALUES ($1, $2, 'failed')",
          [userId, message]
        );
      } catch (e) { /* ignore logging failure */ }
    }
  }
}

// Send an SMS to all active members of a group (for shared-state changes)
async function sendGroupSms(groupId, message) {
  try {
    const members = await pool.query(
      `SELECT u.user_id, u.phone_number
       FROM ikimina_members m
       JOIN users u ON u.user_id = m.user_id
       WHERE m.group_id = $1 AND m.status = 'active'`,
      [groupId]
    );
    for (const mem of members.rows) {
      await sendSms(mem.user_id, mem.phone_number, message);
    }
  } catch (err) {
    console.error("Group SMS failed:", err.message);
  }
}

// USSD member menu (bilingual: 1 = English, 2 = Kinyarwanda)
app.post("/ussd", async (req, res) => {
  const { text, phoneNumber } = req.body;
  let response = "";

  const rawParts = text === "" ? [] : text.split("*");

  if (text === "") {
    res.set("Content-Type", "text/plain");
    return res.send(`CON PesaSmart
Welcome / Murakaza neza
1. English
2. Kinyarwanda`);
  }

  const langDigit = rawParts[0];
  const lang = langDigit === "2" ? "rw" : "en";
  const t = T[lang];

  const parts = rawParts.slice(1);
  const menu = parts.length === 0 ? "" : parts.join("*");
  const section = parts[0];
  const last = parts[parts.length - 1];

  function mainMenu() {
    return `CON PesaSmart
1. ${t.groupStatus}
2. ${t.raiseDispute}
3. ${t.memberChanges}`;
  }

  async function groupStatusMenu(m) {
    const g = await pool.query(
      `SELECT group_id, name, cycle_length, frequency, start_date FROM ikimina_groups WHERE group_id = $1`,
      [m.group_id]
    );
    const info = await weekInfo(g.rows[0]);
    return `CON PesaSmart - ${g.rows[0].name}
${info.header}
1. ${t.myStatus}
2. ${t.whoPaid}
3. ${t.rotationOrder}
4. ${t.openDisputes}`;
  }

  try {
    if (menu === "") {
      response = mainMenu();

    } else if (section === "1" && last === "0" && parts.length >= 3) {
      const m = await findMembershipByPhone(phoneNumber);
      response = m ? await groupStatusMenu(m) : `END ${t.notRegisteredShort}`;

    } else if (menu === "1") {
      const m = await findMembershipByPhone(phoneNumber);
      response = m ? await groupStatusMenu(m) : `END ${t.notRegistered}`;

    } else if (section === "1" && last === "1" && parts.length > 1) {
      const m = await findMembershipByPhone(phoneNumber);
      if (!m) {
        response = `END ${t.notRegisteredShort}`;
      } else {
        const gRes = await pool.query(
          `SELECT contribution_amount FROM ikimina_groups WHERE group_id = $1`,
          [m.group_id]
        );
        const amount = gRes.rows[0].contribution_amount;
        const aheadRes = await pool.query(
          `SELECT COUNT(*) FROM ikimina_members
           WHERE group_id = $1 AND status = 'active'
             AND payout_received = FALSE AND rotation_order < $2`,
          [m.group_id, m.rotation_order]
        );
        const ahead = parseInt(aheadRes.rows[0].count, 10);
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
          nextLine = t.nextPayoutComplete;
        } else if (next.payout_date) {
          const d = new Date(next.payout_date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
          nextLine = fill(t.nextPayoutName, { name: shortName(next.full_name), date: d });
        } else {
          nextLine = fill(t.nextPayoutNameNoDate, { name: shortName(next.full_name) });
        }
        const owe = m.contribution_status === "paid" ? t.oweNothing : fill(t.oweAmount, { amount });
        const gotPaid = m.payout_received ? t.payoutReceivedYes : t.payoutReceivedNo;
        let turnLine;
        if (m.payout_received) turnLine = t.turnAlready;
        else if (ahead === 0) turnLine = t.turnNext;
        else turnLine = fill(t.turnRounds, { n: ahead });

        response = `CON ${t.myStatus}
${t.position} ${m.rotation_order} ${t.of} ${m.cycle_length}
${owe}
${gotPaid}
${turnLine}
${nextLine}
${t.back}`;
      }

    } else if (section === "1" && last === "2") {
      const m = await findMembershipByPhone(phoneNumber);
      if (!m) {
        response = `END ${t.notRegisteredShort}`;
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
        response = `CON ${fill(t.contributions, { paid, total: rows.rows.length })}
${lines.join("\n")}
${t.back}`;
      }

    } else if (section === "1" && last === "3") {
      const m = await findMembershipByPhone(phoneNumber);
      if (!m) {
        response = `END ${t.notRegisteredShort}`;
      } else {
        const rows = await pool.query(
          `SELECT u.full_name, mm.rotation_order, mm.payout_received
           FROM ikimina_members mm
           JOIN users u ON u.user_id = mm.user_id
           WHERE mm.group_id = $1 AND mm.status = 'active'
           ORDER BY mm.rotation_order`,
          [m.group_id]
        );
        const currentTurn = rows.rows.find((r) => !r.payout_received);
        const currentOrder = currentTurn ? currentTurn.rotation_order : null;
        const lines = rows.rows.map((r) => {
          let tag = "";
          if (r.payout_received) tag = ` ${t.paidOut}`;
          else if (r.rotation_order === currentOrder) tag = ` ${t.currentTurn}`;
          return `${r.rotation_order}. ${shortName(r.full_name)}${tag}`;
        });
        response = `CON ${t.rotationOrder}
${lines.join("\n")}
${t.back}`;
      }

    } else if (section === "1" && last === "4") {
      const m = await findMembershipByPhone(phoneNumber);
      if (!m) {
        response = `END ${t.notRegisteredShort}`;
      } else {
        const countRes = await pool.query(
          "SELECT COUNT(*) FROM contribution_disputes WHERE group_id = $1 AND status = 'open'",
          [m.group_id]
        );
        response = `CON ${fill(t.openDisputesCount, { n: countRes.rows[0].count })}
${t.back}`;
      }

    } else if (menu === "2") {
      response = `CON PesaSmart - ${t.raiseDispute}
${t.enterWeek}`;

    } else if (section === "2" && parts.length === 2) {
      const week = parts[1];
      if (!/^\d+$/.test(week)) {
        response = `END ${t.invalidWeek}`;
      } else {
        response = `CON ${fill(t.weekDispute, { week })}
${t.enterTxid}`;
      }

    } else if (section === "2" && parts.length === 3) {
      const week = parts[1];
      const txid = parts[2];
      const m = await findMembershipByPhone(phoneNumber);
      if (!m) {
        response = `END ${t.notRegisteredShort}`;
      } else if (!/^\d+$/.test(week)) {
        response = `END ${t.invalidWeekRetry}`;
      } else if (!txid || txid.length < 3) {
        response = `END ${t.invalidTxid}`;
      } else {
        const ins = await pool.query(
          "INSERT INTO contribution_disputes (group_id, member_id, disputed_week, momo_txid) VALUES ($1, $2, $3, $4) RETURNING dispute_id",
          [m.group_id, m.member_id, parseInt(week, 10), txid]
        );
        const ref = String(ins.rows[0].dispute_id).padStart(4, "0");

        await sendSms(
          m.user_id,
          phoneNumber,
          `PesaSmart: Dispute REF#${ref} raised for Week ${week}. Your organiser has been notified. (Transaction ID recorded, not independently verified.)`
        );

        const orgRes = await pool.query(
          `SELECT u.user_id, u.phone_number
           FROM ikimina_groups g
           JOIN users u ON u.user_id = g.created_by
           WHERE g.group_id = $1`,
          [m.group_id]
        );
        if (orgRes.rows[0]) {
          const org = orgRes.rows[0];
          await sendSms(
            org.user_id,
            org.phone_number,
            `PesaSmart: A member raised dispute REF#${ref} for Week ${week} (TxID: ${txid}). Please review in your dashboard.`
          );
        }

        response = `END ${fill(t.disputeRaised, { ref, week })}`;
      }

    } else if (menu === "3") {
      response = `CON PesaSmart - ${t.memberChanges}
1. ${t.requestExit}
2. ${t.updatePhone}`;

    } else if (menu === "3*1") {
      const m = await findMembershipByPhone(phoneNumber);
      if (!m) {
        response = `END ${t.notRegisteredShort}`;
      } else {
        await pool.query(
          "INSERT INTO membership_changes (group_id, affected_user, change_type) VALUES ($1, $2, 'exit')",
          [m.group_id, m.user_id]
        );
        response = `END ${t.exitSent}`;
      }

    } else if (menu === "3*2") {
      response = `CON ${t.enterNewPhone}`;

    } else if (section === "3" && parts.length === 3 && parts[1] === "2") {
      const newPhone = parts[2];
      const m = await findMembershipByPhone(phoneNumber);
      if (!m) {
        response = `END ${t.notRegisteredShort}`;
      } else if (!/^\d{6,15}$/.test(newPhone)) {
        response = `END ${t.invalidPhone}`;
      } else {
        await pool.query(
          "INSERT INTO membership_changes (group_id, affected_user, change_type, details) VALUES ($1, $2, 'phone_update', $3)",
          [m.group_id, m.user_id, newPhone]
        );
        response = `END ${t.phoneSent}`;
      }

    } else {
      response = `END ${t.invalidChoice}`;
    }
  } catch (err) {
    response = `END ${t.somethingWrong}`;
  }

  res.set("Content-Type", "text/plain");
  res.send(response);
});

// Create a new Ikimina group
app.post("/api/groups", requireAuth, async (req, res) => {
  const { name, contributionAmount, frequency, cycleLength, startDate, createdBy } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ status: "error", message: "Group name is required" });
  }
  if (isNaN(contributionAmount) || Number(contributionAmount) <= 0) {
    return res.status(400).json({ status: "error", message: "Enter a valid contribution amount" });
  }
  if (isNaN(cycleLength) || Number(cycleLength) < 1) {
    return res.status(400).json({ status: "error", message: "Enter a valid cycle length" });
  }
  try {
    const result = await pool.query(
      "INSERT INTO ikimina_groups (name, contribution_amount, frequency, cycle_length, start_date, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
      [name.trim(), contributionAmount, frequency, cycleLength, startDate, createdBy]
    );
    res.status(201).json({ status: "success", group: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.get("/api/groups", requireAuth, async (req, res) => {
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

app.get("/api/groups/:groupId", requireAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM ikimina_groups WHERE group_id = $1", [req.params.groupId]);
    if (result.rows.length === 0) return res.status(404).json({ status: "error", message: "Group not found" });
    res.json({ status: "success", group: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.get("/api/groups/:groupId/members", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.member_id, m.user_id, m.rotation_order, m.contribution_status, m.payout_received, m.status,
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

app.post("/api/groups/:groupId/members", requireAuth, async (req, res) => {
  const { groupId } = req.params;
  const { fullName, phoneNumber } = req.body;
  if (!fullName || !fullName.trim()) {
    return res.status(400).json({ status: "error", message: "Member name is required" });
  }
  if (!/^\d{9,15}$/.test((phoneNumber || "").replace(/\D/g, ""))) {
    return res.status(400).json({ status: "error", message: "Enter a valid phone number (digits only)" });
  }
  try {
    let userResult = await pool.query("SELECT user_id FROM users WHERE phone_number = $1", [phoneNumber.trim()]);
    let userId;
    if (userResult.rows.length > 0) {
      userId = userResult.rows[0].user_id;
    } else {
      const insertUser = await pool.query(
        "INSERT INTO users (full_name, phone_number) VALUES ($1, $2) RETURNING user_id",
        [fullName.trim(), phoneNumber.trim()]
      );
      userId = insertUser.rows[0].user_id;
    }

    const existing = await pool.query(
      "SELECT member_id FROM ikimina_members WHERE user_id = $1 AND group_id = $2",
      [userId, groupId]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ status: "error", message: "This phone number is already a member of this group" });
    }

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

app.patch("/api/members/:memberId/contribution", requireAuth, async (req, res) => {
  const { memberId } = req.params;
  const { status } = req.body;
  try {
    const result = await pool.query(
      "UPDATE ikimina_members SET contribution_status = $1 WHERE member_id = $2 RETURNING *",
      [status, memberId]
    );
    if (result.rows.length === 0) return res.status(404).json({ status: "error", message: "Member not found" });
    const member = result.rows[0];

    if (status === "paid") {
      const u = await pool.query("SELECT phone_number FROM users WHERE user_id = $1", [member.user_id]);
      if (u.rows[0]) {
        await sendSms(member.user_id, u.rows[0].phone_number, "PesaSmart: Your contribution for this round has been confirmed as paid.");
      }
    }

    res.json({ status: "success", member });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// Mark a member's payout as received (advances the rotation)
app.patch("/api/members/:memberId/payout", requireAuth, async (req, res) => {
  const { memberId } = req.params;
  const { received } = req.body;
  try {
    const result = await pool.query(
      "UPDATE ikimina_members SET payout_received = $1 WHERE member_id = $2 RETURNING *",
      [received, memberId]
    );
    if (result.rows.length === 0) return res.status(404).json({ status: "error", message: "Member not found" });
    const member = result.rows[0];

    if (received) {
      const u = await pool.query("SELECT phone_number FROM users WHERE user_id = $1", [member.user_id]);
      if (u.rows[0]) {
        await sendSms(member.user_id, u.rows[0].phone_number, "PesaSmart: You have been recorded as having received your payout for this round.");
      }
    }

    res.json({ status: "success", member });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.get("/api/groups/:groupId/disputes", requireAuth, async (req, res) => {
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

app.patch("/api/disputes/:disputeId", requireAuth, async (req, res) => {
  const { disputeId } = req.params;
  const { status } = req.body;
  try {
    const resolvedAt = status === "resolved" ? "NOW()" : "NULL";
    const result = await pool.query(
      `UPDATE contribution_disputes SET status = $1, resolved_at = ${resolvedAt} WHERE dispute_id = $2 RETURNING *`,
      [status, disputeId]
    );
    if (result.rows.length === 0) return res.status(404).json({ status: "error", message: "Dispute not found" });
    const dispute = result.rows[0];

    if (status === "resolved") {
      const u = await pool.query(
        `SELECT u.user_id, u.phone_number
         FROM ikimina_members m JOIN users u ON u.user_id = m.user_id
         WHERE m.member_id = $1`,
        [dispute.member_id]
      );
      if (u.rows[0]) {
        const ref = String(dispute.dispute_id).padStart(4, "0");
        await sendSms(u.rows[0].user_id, u.rows[0].phone_number, `PesaSmart: Your dispute REF#${ref} has been resolved by your organiser.`);
      }
    }

    res.json({ status: "success", dispute });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.get("/api/groups/:groupId/changes", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.change_id, c.change_type, c.status, c.details, c.created_at,
              u.full_name, u.phone_number
       FROM membership_changes c
       LEFT JOIN users u ON u.user_id = c.affected_user
       WHERE c.group_id = $1
       ORDER BY c.created_at DESC`,
      [req.params.groupId]
    );
    res.json({ status: "success", changes: result.rows });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.patch("/api/changes/:changeId", requireAuth, async (req, res) => {
  const { changeId } = req.params;
  const { decision } = req.body;
  try {
    const cRes = await pool.query("SELECT * FROM membership_changes WHERE change_id = $1", [changeId]);
    if (cRes.rows.length === 0) return res.status(404).json({ status: "error", message: "Request not found" });
    const change = cRes.rows[0];

    if (change.status === "approved") {
      return res.status(409).json({ status: "error", message: "This request was already approved and cannot be changed." });
    }

    const memberRes = await pool.query(
      "SELECT user_id, phone_number, full_name FROM users WHERE user_id = $1",
      [change.affected_user]
    );
    const member = memberRes.rows[0];

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

    if (member) {
      let msg;
      if (change.change_type === "exit") {
        msg = decision === "approved"
          ? `PesaSmart: Your request to exit the group has been approved.`
          : `PesaSmart: Your request to exit the group was not approved. Please contact your organiser.`;
      } else {
        msg = decision === "approved"
          ? `PesaSmart: Your phone number update has been approved and applied.`
          : `PesaSmart: Your phone number update request was not approved. Please contact your organiser.`;
      }
      const notifyPhone = (decision === "approved" && change.change_type === "phone_update")
        ? change.details
        : member.phone_number;
      await sendSms(member.user_id, notifyPhone, msg);
    }

    // Group-wide notice for shared-state changes
    if (decision === "approved" && member) {
      if (change.change_type === "exit") {
        await sendGroupSms(change.group_id, `PesaSmart: ${member.full_name} has left the group. The rotation has been updated.`);
      } else if (change.change_type === "phone_update") {
        await sendGroupSms(change.group_id, `PesaSmart: ${member.full_name}'s registered phone number has been updated.`);
      }
    }

    res.json({ status: "success", change: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ status: "error", message: "That phone number is already in use by another user" });
    }
    res.status(500).json({ status: "error", message: err.message });
  }
});

// Dashboard summary stats for an organiser
app.get("/api/stats", requireAuth, async (req, res) => {
  const { createdBy } = req.query;
  try {
    const result = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM ikimina_groups WHERE created_by = $1) AS groups,
         (SELECT COUNT(*) FROM ikimina_members m
            JOIN ikimina_groups g ON g.group_id = m.group_id
            WHERE g.created_by = $1 AND m.status = 'active') AS members,
         (SELECT COUNT(*) FROM contribution_disputes d
            JOIN ikimina_groups g ON g.group_id = d.group_id
            WHERE g.created_by = $1 AND d.status = 'open') AS open_disputes,
         (SELECT COUNT(*) FROM membership_changes c
            JOIN ikimina_groups g ON g.group_id = c.group_id
            WHERE g.created_by = $1 AND c.status = 'pending') AS pending_requests`,
      [createdBy]
    );
    res.json({ status: "success", stats: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.post("/api/groups/:groupId/broadcast", requireAuth, async (req, res) => {
  const { groupId } = req.params;
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ status: "error", message: "Message cannot be empty" });
  }
  try {
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

    const recipients = members.rows.map((r) => {
      const last9 = r.phone_number.replace(/\D/g, "").slice(-9);
      return "+250" + last9;
    });

    const AfricasTalking = require("africastalking")({
      username: process.env.AT_USERNAME,
      apiKey: process.env.AT_API_KEY,
    });
    await AfricasTalking.SMS.send({ to: recipients, message });

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