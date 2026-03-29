import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// Twilio webhook
app.post("/voice", (req, res) => {
  res.set("Content-Type", "text/xml");
  res.send(`
    <Response>
      <Connect>
        <Stream url="wss://${req.headers.host}/media-stream" />
      </Connect>
    </Response>
  `);
});

const server = app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

// WebSocket
const wss = new WebSocketServer({ server, path: "/media-stream" });

wss.on("connection", (ws) => {
  console.log("Caller connected");

  const deepgram = new WebSocket(
    "wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000",
    {
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      },
    }
  );

  deepgram.on("message", async (msg) => {
    const data = JSON.parse(msg.toString());
    const transcript = data.channel?.alternatives[0]?.transcript;

    if (transcript) {
      console.log("User:", transcript);

      const reply = await getAIResponse(transcript);
      const audio = await textToSpeech(reply);

      ws.send(
        JSON.stringify({
          event: "media",
          media: { payload: audio },
        })
      );
    }
  });

  ws.on("message", (message) => {
    const data = JSON.parse(message.toString());

    if (data.event === "media") {
      deepgram.send(Buffer.from(data.media.payload, "base64"));
    }
  });
});

// GPT response
async function getAIResponse(text) {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are Emily, a young British pharmacy receptionist.

Speak naturally like a human:
- Use fillers like "yeah...", "okay...", "just a sec..."
- Keep sentences short
- Sound slightly busy but friendly
- Never sound robotic`,
        },
        { role: "user", content: text },
      ],
      max_tokens: 50,
      temperature: 0.7,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    }
  );

  return res.data.choices[0].message.content;
}

// ElevenLabs TTS
async function textToSpeech(text) {
  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
    {
      text,
      model_id: "eleven_turbo_v2",
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.8,
      },
    },
    {
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
      },
      responseType: "arraybuffer",
    }
  );

  return Buffer.from(res.data).toString("base64");
}
