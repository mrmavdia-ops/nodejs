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

// ===== TEMP STORAGE =====
let bookings = [];
let calls = [];
let lastHandled = {}; // prevent duplicate SMS

// ===== HEALTH =====
app.get("/", (req, res) => {
  res.send("ReceptX Backend Running 🚀");
});

// =====================================================
// 📡 VAPI WEBHOOK
// =====================================================
app.post("/api/vapi/webhook", async (req, res) => {
  try {
    console.log("📥 VAPI WEBHOOK RECEIVED");
    console.log(JSON.stringify(req.body, null, 2));

    // ===== EXTRACT DATA =====
    const caller =
      req.body?.customer?.number ||
      req.body?.from ||
      null;

    const message =
      req.body?.messages?.[req.body.messages.length - 1]?.content ||
      "";

    const callId = req.body?.call?.id || "unknown";

    console.log("📞 RAW CALLER:", caller);
    console.log("🧠 Message:", message);

    if (!caller) {
      console.log("❌ No caller found");
      return res.sendStatus(200);
    }

    // ===== NORMALIZE PHONE =====
    const phone = caller.startsWith("+") ? caller : `+${caller}`;

    if (!phone || phone.length < 10) {
      console.log("❌ Invalid phone:", phone);
      return res.sendStatus(200);
    }

    // ===== PREVENT DUPLICATES =====
    if (lastHandled[phone] && Date.now() - lastHandled[phone] < 10000) {
      console.log("⏱️ Skipping duplicate request");
      return res.sendStatus(200);
    }

    lastHandled[phone] = Date.now();

    // =====================================================
    // 🧠 INTENT DETECTION
    // =====================================================
    let intent = "general";

    if (/book|appointment|reserve/i.test(message)) {
      intent = "booking";
    }

    if (/cancel/i.test(message)) {
      intent = "cancel";
    }

    // =====================================================
    // 📅 BOOKING
    // =====================================================
    if (intent === "booking") {
      const booking = {
        id: Date.now(),
        phone,
        message,
        status: "confirmed",
        created_at: new Date()
      };

      bookings.push(booking);

      console.log("📅 Booking stored:", booking);

      await sendSMS(
        phone,
        "ReceptX: Your appointment is confirmed. We’ll see you soon."
      );
    }

    // =====================================================
    // ❌ CANCEL
    // =====================================================
    if (intent === "cancel") {
      bookings = bookings.map((b) => {
        if (b.phone === phone) {
          b.status = "cancelled";
        }
        return b;
      });

      console.log("❌ Booking cancelled for:", phone);

      await sendSMS(
        phone,
        "ReceptX: Your appointment has been cancelled."
      );
    }

    // =====================================================
    // 📞 CALL LOG
    // =====================================================
    calls.push({
      id: callId,
      phone,
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
// 📊 DASHBOARD API
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
// 📩 SMS FUNCTION (FINAL FIXED)
// =====================================================
async function sendSMS(to, message) {
  try {
    if (!to) {
      console.log("❌ No 'to' number");
      return;
    }

    const phone = to.startsWith("+") ? to : `+${to}`;

    console.log("📩 Sending SMS to:", phone);

    const sms = await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone,
      body: message
    });

    console.log("✅ SMS sent:", sms.sid);

  } catch (err) {
    console.error("❌ Twilio ERROR:", err.message);
  }
}

// =====================================================
// 🚀 START SERVER
// =====================================================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

