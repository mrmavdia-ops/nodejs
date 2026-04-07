import express from "express";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ===== BASIC ROUTE =====
app.get("/", (req, res) => {
  res.send("PharmaAI Streaming Running 🚀");
});

const server = app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});

// ===== GLOBAL CONTROL =====
let isSpeaking = false;
let lastResponseTime = 0;

// ===== WEBSOCKET SERVER =====
const wss = new WebSocketServer({
  server,
  path: "/media-stream"
});

wss.on("connection", (ws) => {
  console.log("📞 Caller connected");

  let streamSid = null;

  // ===== DEEPGRAM REAL-TIME =====
  const deepgram = new WebSocket(
    "wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&interim_results=true",
    {
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      },
    }
  );

  deepgram.on("open", () => {
    console.log("🎤 Deepgram connected");
  });

  // ===== TRANSCRIPT HANDLER (LOW LATENCY) =====
  deepgram.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      const transcript = data.channel?.alternatives[0]?.transcript;
      const isFinal = data.is_final;

      if (!transcript) return;

      console.log("🗣 Partial:", transcript);

      // 🚀 START EARLY (no waiting full sentence)
      if (
        transcript.length > 8 &&
        !isSpeaking &&
        Date.now() - lastResponseTime > 1200
      ) {
        isSpeaking = true;
        lastResponseTime = Date.now();

        handleAIResponse(transcript, ws, streamSid);
      }

      // Reset when user finishes speaking
      if (isFinal) {
        isSpeaking = false;
      }

    } catch (err) {
      console.log("Deepgram error:", err.message);
    }
  });

  deepgram.on("error", (err) => {
    console.log("Deepgram error:", err.message);
  });

  // ===== RECEIVE AUDIO FROM TWILIO =====
  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.event === "start") {
        streamSid = data.start.streamSid;
        console.log("▶️ Stream started:", streamSid);
      }

      if (data.event === "media") {
        const audioBuffer = Buffer.from(data.media.payload, "base64");
        deepgram.send(audioBuffer);
      }

      if (data.event === "stop") {
        console.log("⛔ Call ended");
        deepgram.close();
      }

    } catch (err) {
      console.log("WS error:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("❌ Caller disconnected");
    deepgram.close();
  });
});


// ===== AI RESPONSE =====
async function getAIResponse(text) {
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        temperature: 0.5,
        max_tokens: 40,
        messages: [
          {
            role: "system",
            content: `
You are Emily, a professional British pharmacy receptionist.

Speak:
- natural
- short (1 sentence)
- human tone
- slightly busy

Never:
- repeat
- be robotic
`
          },
          { role: "user", content: text }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    return res.data.choices[0].message.content;

  } catch (err) {
    console.log("OpenAI error:", err.message);
    return "Yeah… just a sec…";
  }
}


// ===== ELEVENLABS (FAST MODE) =====
async function getElevenLabsAudio(text) {
  try {
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
      {
        text,
        model_id: "eleven_turbo_v2",
        optimize_streaming_latency: 4, // 🔥 KEY FOR SPEED
        output_format: "ulaw_8000"     // 🔥 REQUIRED FOR TWILIO
      },
      {
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json"
        },
        responseType: "arraybuffer",
        timeout: 8000
      }
    );

    return Buffer.from(res.data).toString("base64");

  } catch (err) {
    console.log("ElevenLabs error:", err.message);
    return null;
  }
}


// ===== AI PIPELINE =====
async function handleAIResponse(text, ws, streamSid) {
  try {
    console.log("⚡ Processing:", text);

    const aiReply = await getAIResponse(text);
    console.log("🤖 AI:", aiReply);

    const audio = await getElevenLabsAudio(aiReply);

    if (audio && streamSid) {
      ws.send(JSON.stringify({
        event: "media",
        streamSid,
        media: {
          payload: audio
        }
      }));
    }

  } catch (err) {
    console.log("Pipeline error:", err.message);
  }
}
