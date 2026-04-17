require("dotenv").config();

const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const twilio = require("twilio");

const app = express();

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

// ===== ENV =====
const PORT = process.env.PORT || 3000;

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ===== TEMP STORAGE (replace with DB later) =====
let bookings = [];
let calls = [];

// ===== HEALTH =====
app.get("/", (req, res) => {
  res.send("ReceptX Backend Running 🚀");
});

// =====================================================
// 📡 VAPI WEBHOOK (CORE SYSTEM)
// =====================================================
app.post("/api/vapi/webhook", async (req, res) => {
  try {
    console.log("📥 VAPI WEBHOOK RECEIVED");
    console.log(JSON.stringify(req.body, null, 2));

    // ===== EXTRACT DATA SAFELY =====
    const caller =
      req.body?.customer?.number ||
      req.body?.from ||
      null;

    const message =
      req.body?.messages?.[req.body.messages.length - 1]?.content ||
      "";

    const callId = req.body?.call?.id || "unknown";

    if (!caller) {
      console.log("❌ No caller found");
      return res.sendStatus(200);
    }

    console.log("📞 Caller:", caller);
    console.log("🧠 Message:", message);

    // =====================================================
    // 🧠 SIMPLE INTENT DETECTION (CAN UPGRADE LATER)
    // =====================================================
    let intent = "general";

    if (/book|appointment|reserve/i.test(message)) {
      intent = "booking";
    }

    if (/cancel/i.test(message)) {
      intent = "cancel";
    }

    // =====================================================
    // 📅 BOOKING LOGIC
    // =====================================================
    if (intent === "booking") {
      const booking = {
        id: Date.now(),
        phone: caller,
        message,
        status: "confirmed",
        created_at: new Date()
      };

      bookings.push(booking);

      console.log("📅 Booking stored:", booking);

      // ===== SEND SMS =====
      await sendSMS(
        caller,
        "ReceptX: Your booking is confirmed. We look forward to seeing you."
      );
    }

    // =====================================================
    // ❌ CANCEL LOGIC
    // =====================================================
    if (intent === "cancel") {
      bookings = bookings.map((b) => {
        if (b.phone === caller) {
          b.status = "cancelled";
        }
        return b;
      });

      console.log("❌ Booking cancelled for:", caller);

      await sendSMS(
        caller,
        "ReceptX: Your booking has been cancelled."
      );
    }

    // =====================================================
    // 📞 CALL LOG
    // =====================================================
    calls.push({
      id: callId,
      phone: caller,
      message,
      created_at: new Date()
    });

    res.sendStatus(200);

  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    res.sendStatus(200);
  }
});

// =====================================================
// 📊 DASHBOARD API (FOR LOVABLE FRONTEND)
// =====================================================
app.get("/api/dashboard", (req, res) => {
  res.json({
    bookings,
    calls,
    stats: {
      totalBookings: bookings.length,
      totalCalls: calls.length
    }
  });
});

// =====================================================
// 📩 SMS FUNCTION (SAFE)
// =====================================================
async function sendSMS(to, message) {
  if (!to) {
    console.log("⚠️ SMS skipped (no number)");
    return;
  }

  try {
    const sms = await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
      body: message
    });

    console.log("📩 SMS sent:", sms.sid);

  } catch (err) {
    console.error("❌ SMS error:", err.message);
  }
}

// =====================================================
// 🚀 START SERVER
// =====================================================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

