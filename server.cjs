wss.on('connection', (ws) => {
  console.log("🔌 Twilio connected");

  let caller = null;
  let hasResponded = false; // 🔥 prevent spam loop

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);

      // ===== CAPTURE CALLER =====
      if (data.event === "start") {
        caller = data.start.from;
        console.log("📞 Caller:", caller);
      }

      // ===== HANDLE AUDIO =====
      if (data.event === "media" && !hasResponded) {

        hasResponded = true; // 🔥 only respond once (important)

        // TEMP transcript (until Deepgram)
        const transcript = "Book an appointment tomorrow";

        console.log("User said:", transcript);

        let aiReply = "";

        // ===== BOOKING LOGIC =====
        if (/book/i.test(transcript)) {
          aiReply = "Your appointment is booked for tomorrow.";

          const toNumber = caller || process.env.TEST_PHONE_NUMBER;

          try {
            await twilioClient.messages.create({
              from: process.env.TWILIO_PHONE_NUMBER,
              to: toNumber,
              body: "ReceptX: Appointment confirmed for tomorrow."
            });

            console.log("📩 SMS sent to:", toNumber);

          } catch (err) {
            console.error("SMS Error:", err.message);
          }

        } else {
          // ===== OPENAI =====
          const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content: "You are a polite UK pharmacy receptionist."
              },
              {
                role: "user",
                content: transcript
              }
            ]
          });

          aiReply = completion.choices[0].message.content;
        }

        console.log("AI:", aiReply);

        // ===== ELEVENLABS STREAM =====
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
      }

    } catch (err) {
      console.error("Error:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("❌ Disconnected");
  });
});

// ===== START =====
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});

On 14-Apr-2026, at 8:28 PM, Asad Zake <mmmavdia@gmail.com> wrote:

require('dotenv').config();

const express = require('express');
const http = require('http');
const twilio = require('twilio');
const { WebSocketServer } = require('ws');
const OpenAI = require('openai');
const axios = require('axios');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const elevenKey = process.env.ELEVENLABS_API_KEY;
const elevenVoiceId = process.env.ELEVENLABS_VOICE_ID;

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ===== HEALTH =====
app.get('/', (req, res) => {
  res.send('ReceptX Voice AI Running 🚀');
});

// ===== TWILIO VOICE =====
app.post('/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const connect = twiml.connect();
  connect.stream({
    url: `wss://${req.headers.host}/stream`
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

// ===== SERVER =====
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  console.log("🔌 Twilio connected");

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.event === "media") {

        // 🔥 TEMP INPUT (until Deepgram added properly)
        const transcript = "Book an appointment tomorrow";

        console.log("User said:", transcript);

        let aiReply = "";

        // ===== SIMPLE BOOKING LOGIC =====
        if (/book/i.test(transcript)) {
          aiReply = "Your appointment is booked for tomorrow.";

          // SMS send
          await twilioClient.messages.create({
            from: process.env.TWILIO_PHONE_NUMBER,
            to: process.env.TEST_PHONE_NUMBER,
            body: "ReceptX: Appointment confirmed for tomorrow."
          });

        } else {
          // ===== OPENAI =====
          const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content: "You are a polite UK pharmacy receptionist."
              },
              {
                role: "user",
                content: transcript
              }
            ]
          });

          aiReply = completion.choices[0].message.content;
        }

        console.log("AI:", aiReply);

        // ===== ELEVENLABS STREAM =====
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
      }

    } catch (err) {
      console.error("Error:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("❌ Disconnected");
  });
});

// ===== START =====
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});

