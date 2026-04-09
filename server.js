require("dotenv").config();

const express = require("express");
const http = require("http");
const twilio = require("twilio");
const axios = require("axios");
const { WebSocketServer } = require("ws");

const app = express();
app.use(express.urlencoded({ extended: true }));

// ===== HEALTH =====
app.get("/", (req, res) => {
  res.send("PharmaAI Streaming Running 🚀");
});

// ===== TWILIO VOICE ENTRY =====
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  // 🔥 DIRECT STREAM (NO GREETING, NO DELAY)
  twiml.connect().stream({
    url: `wss://${req.headers.host}/stream`
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

// ===== CREATE SERVER =====
const server = http.createServer(app);

// ===== WEBSOCKET SERVER =====
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("🔌 Twilio connected");

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);

      // We only care about audio stream
      if (data.event === "media") {

        // 👉 TEMP RESPONSE (replace later with AI)
        const replyText = "Yeah... just checking that for you now.";

        // 🔥 ELEVENLABS STREAM (REAL-TIME)
        const response = await axios({
          method: "POST",
          url: `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}/stream`,
          data: {
            text: replyText,
            model_id: "eleven_turbo_v2",
            output_format: "ulaw_8000", // ✅ CRITICAL
            voice_settings: {
              stability: 0.4,
              similarity_boost: 0.85
            }
          },
          headers: {
            "xi-api-key": process.env.ELEVENLABS_API_KEY,
            "Content-Type": "application/json"
          },
          responseType: "stream"
        });

        // 🎧 STREAM AUDIO BACK TO TWILIO
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
      console.error("Stream error:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("❌ Twilio disconnected");
  });
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});

