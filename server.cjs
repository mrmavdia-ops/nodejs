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

// ===== TEMP DATABASE =====
let bookings = [];
let calls = [];
let lastHandled = {};

// ===== BUSINESS CONFIG =====
const businessConfigs = {
  "restaurant_1": {
    name: "Spice Grill",
    type: "restaurant",
    opening_hours: {
      mon: ["09:00", "22:00"],
      tue: ["09:00", "22:00"],
      wed: ["09:00", "22:00"],
      thu: ["09:00", "22:00"],
      fri: ["09:00", "23:00"],
      sat: ["10:00", "23:00"],
      sun: ["10:00", "21:00"]
    },
    slot_duration: 30,
    max_per_slot: 2
  }
};

// ===== HEALTH =====
app.get("/", (req, res) => {
  res.send("ReceptX SaaS Running 🚀");
});

// =====================================================
// 📡 VAPI WEBHOOK
// =====================================================
app.post("/api/vapi/webhook", async (req, res) => {
  try {
    console.log("📥 VAPI:", JSON.stringify(req.body, null, 2));

    // ===== EXTRACT CALLER =====
    const caller =
      req.body?.customer?.number ||
      req.body?.call?.customer?.number ||
      req.body?.call?.from ||
      req.body?.from ||
      null;

    const message =
      req.body?.messages?.slice(-1)[0]?.content || "";

    const businessId =
      req.body?.metadata?.business_id ||
      req.body?.assistant?.metadata?.business_id ||
      "restaurant_1";

    const business = businessConfigs[businessId];

    if (!caller || !business) {
      console.log("❌ Missing caller/business");
      return res.sendStatus(200);
    }

    const phone = caller.startsWith("+") ? caller : `+${caller}`;

    // ===== DUPLICATE BLOCK =====
    if (lastHandled[phone] && Date.now() - lastHandled[phone] < 8000) {
      console.log("⏱️ Duplicate blocked");
      return res.sendStatus(200);
    }
    lastHandled[phone] = Date.now();

    console.log("📞 Caller:", phone);
    console.log("🏢 Business:", business.name);
    console.log("🧠 Message:", message);

    // =====================================================
    // 🧠 INTENT
    // =====================================================
    let intent = "general";

    if (/book|appointment|reserve/i.test(message)) intent = "booking";
    if (/cancel/i.test(message)) intent = "cancel";

    // =====================================================
    // 📅 BOOKING LOGIC WITH AVAILABILITY
    // =====================================================
    if (intent === "booking") {
      const bookingTime = new Date(Date.now() + 60 * 60 * 1000); // temp: +1hr

      if (!isWithinHours(bookingTime, business)) {
        await sendSMS(phone, `${business.name}: We are closed at that time.`);
        return res.sendStatus(200);
      }

      if (!isSlotAvailable(bookingTime, businessId, business)) {
        await sendSMS(
          phone,
          `${business.name}: That time is fully booked. Please try another time.`
        );
        return res.sendStatus(200);
      }

      const booking = {
        id: Date.now(),
        business_id: businessId,
        phone,
        time: bookingTime,
        status: "confirmed"
      };

      bookings.push(booking);

      console.log("📅 Booking saved:", booking);

      await sendSMS(
        phone,
        `${business.name}: Your booking is confirmed for ${bookingTime.toLocaleString("en-GB")}`
      );
    }

    // =====================================================
    // ❌ CANCEL
    // =====================================================
    if (intent === "cancel") {
      bookings = bookings.map((b) => {
        if (b.phone === phone) b.status = "cancelled";
        return b;
      });

      await sendSMS(
        phone,
        `${business.name}: Your booking has been cancelled.`
      );
    }

    // =====================================================
    // 📞 CALL LOG
    // =====================================================
    calls.push({
      phone,
      business_id: businessId,
      message,
      created_at: new Date()
    });

    res.sendStatus(200);

  } catch (err) {
    console.error("❌ ERROR:", err);
    res.sendStatus(200);
  }
});

// =====================================================
// 📊 DASHBOARD API
// =====================================================
app.get("/api/dashboard", (req, res) => {
  res.json({ bookings, calls });
});

// =====================================================
// 📅 CHECK HOURS
// =====================================================
function isWithinHours(date, business) {
  const day = ["sun","mon","tue","wed","thu","fri","sat"][date.getDay()];
  const hours = business.opening_hours[day];

  if (!hours) return false;

  const [start, end] = hours;

  const current = date.toTimeString().slice(0,5);

  return current >= start && current <= end;
}

// =====================================================
// 📅 SLOT CHECK
// =====================================================
function isSlotAvailable(time, businessId, business) {
  const sameSlot = bookings.filter(
    b =>
      b.business_id === businessId &&
      new Date(b.time).getTime() === new Date(time).getTime() &&
      b.status === "confirmed"
  );

  return sameSlot.length < business.max_per_slot;
}

// =====================================================
// 📩 SMS (FINAL FIXED)
// =====================================================
async function sendSMS(to, message) {
  try {
    if (!to) return;

    const phone = to.startsWith("+") ? to : `+${to}`;

    console.log("📩 SMS →", phone);

    const sms = await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone,
      body: message
    });

    console.log("✅ SMS:", sms.sid);

  } catch (err) {
    console.error("❌ SMS ERROR:", err);
  }
}

// =====================================================
// 🚀 START
// =====================================================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
