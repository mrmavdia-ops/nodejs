require('dotenv').config();

const express = require('express');
const http = require('http');
const twilio = require('twilio');
const { WebSocketServer } = require('ws');
const OpenAI = require('openai');
const axios = require('axios');

// ✅ NEW Deepgram v3 SDK
const { createClient } = require('@deepgram/sdk');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ===== CLIENTS =====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const elevenKey = process.env.ELEVENLABS_API_KEY;
const elevenVoiceId = process.env.ELEVENLABS_VOICE_ID;

// ===== MEMORY (replace with DB later) =====
let appointments = [];

// ===== HEALTH =====
app.get('/', (req, res) => {
  res.send('ReceptX Voice AI Running 🚀');
});

// ===== TWILIO VOICE ENTRY =====
app.post('/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const caller = req.body.From || "";

  const connect = twiml.connect();
  connect.stream({
    url: `wss://${req.headers.host}/stream?caller=${encodeURIComponent(caller)}`
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

// ===== SERVER =====
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  console.log("🔌 Twilio connected");

  // ===== GET CALLER =====
  const url = new URL(req.url, `http://${req.headers.host}`);
  const caller = url.searchParams.get('caller');

  console.log("📞 Caller:", caller);

  // ===== DEEPGRAM LIVE =====
  const dg = deepgram.listen.live({
    model: "nova-2",
    language: "en-GB",
    smart_format: true
  });

  dg.on('open', () => console.log("🎤 Deepgram connected"));

  dg.on('transcript', async (data) => {
    const transcript = data.channel?.alternatives?.[0]?.transcript;

    if (!transcript || transcript.length < 3) return;

    console.log("User said:", transcript);

    let aiReply = "";
    let handled = false;

    // ===== BOOKING LOGIC =====
    if (/book|appointment/i.test(transcript)) {
      const date = new Date(Date.now() + 86400000); // tomorrow

      appointments.push({ caller, date });

      aiReply = `Your appointment is confirmed for ${date.toLocaleString('en-GB')}.`;

      // ===== SMS SAFE =====
      if (caller) {
        try {
          await twilioClient.messages.create({
            from: process.env.TWILIO_PHONE_NUMBER,
            to: caller,
            body: aiReply
          });
        } catch (err) {
          console.error("SMS failed:", err.message);
        }
      }

      handled = true;
    }

    // ===== CANCEL LOGIC =====
    if (!handled && /cancel/i.test(transcript)) {
      appointments = appointments.filter(a => a.caller !== caller);

      aiReply = "Your appointment has been cancelled.";

      if (caller) {
        try {
          await twilioClient.messages.create({
            from: process.env.TWILIO_PHONE_NUMBER,
            to: caller,
            body: aiReply
          });
        } catch (err) {
          console.error("SMS failed:", err.message);
        }
      }

      handled = true;
    }

    // ===== OPENAI =====
    if (!handled) {
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.5,
          max_tokens: 60,
          messages: [
            {
              role: "system",
              content: "You are a polite UK pharmacy receptionist. Speak naturally and briefly."
            },
            {
              role: "user",
              content: transcript
            }
          ]
        });

        aiReply = completion.choices[0].message.content;

      } catch (err) {
        console.error("OpenAI error:", err.message);
        aiReply = "Just a moment please.";
      }
    }

    console.log("AI:", aiReply);

    // ===== ELEVENLABS STREAM =====
    try {
      const response = await axios({
        method: "POST",
        url: `https://api.elevenlabs.io/v1/text-to-speech/${elevenVoiceId}/stream`,
        data: {
          text: aiReply,
          model_id: "eleven_turbo_v2",
          output_format: "ulaw_8000"
        },
        headers: {
          "xi-api-key": elevenKey
        },
        responseType: "stream"
      });

      response.data.on("data", (chunk) => {
        ws.send(JSON.stringify({
          event: "media",
          media: {
            payload: chunk.toString("base64")
          }
        }));
      });

    } catch (err) {
      console.error("ElevenLabs error:", err.message);
    }
  });

  // ===== AUDIO → DEEPGRAM =====
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.event === "media") {
        const audio = Buffer.from(data.media.payload, "base64");
        dg.send(audio);
      }

    } catch (err) {
      console.error("WS message error:", err.message);
    }
  });

  ws.on('close', () => {
    console.log("❌ Disconnected");
    dg.finish();
  });
});

// ===== START =====
server.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});

