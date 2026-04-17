require('dotenv').config();

const express = require('express');
const http = require('http');
const twilio = require('twilio');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== ENV =====
const PORT = process.env.PORT || 3000;

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ===== HEALTH CHECK =====
app.get('/', (req, res) => {
  res.send('ReceptX Backend Running 🚀');
});

// ===== VAPI WEBHOOK =====
app.post('/api/vapi/webhook', async (req, res) => {
  try {
    console.log("📥 Incoming Vapi webhook:");
    console.log(JSON.stringify(req.body, null, 2));

    // ===== GET CALLER NUMBER =====
    const caller =
      req.body?.customer?.number ||
      req.body?.from ||
      null;

    if (!caller) {
      console.log("❌ No caller number found");
      return res.sendStatus(200);
    }

    console.log("📞 Caller:", caller);

    // ===== BASIC INTENT (OPTIONAL LOGIC) =====
    const transcript =
      req.body?.messages?.[req.body.messages.length - 1]?.content ||
      "No transcript";

    console.log("🧠 Last message:", transcript);

    // ===== SEND SMS =====
    const sms = await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: caller,
      body: "ReceptX: Your appointment is confirmed. Thank you!"
    });

    console.log("✅ SMS sent:", sms.sid);

    // ===== RESPONSE =====
    res.sendStatus(200);

  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    res.sendStatus(200);
  }
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
})
