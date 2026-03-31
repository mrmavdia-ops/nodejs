require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const twilio = require("twilio");
const { createClient } = require("@deepgram/sdk");

const app = express();
const PORT = process.env.PORT || 3000;

// Deepgram client
const deepgram = process.env.DEEPGRAM_API_KEY
  ? createClient(process.env.DEEPGRAM_API_KEY)
  : null;

// TTS temp storage
const TTS_DIR = path.join(__dirname, "tmp_tts");
if (!fs.existsSync(TTS_DIR)) fs.mkdirSync(TTS_DIR, { recursive: true });

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ✅ ROOT ROUTE (fixes "Cannot GET /")
app.get("/", (req, res) => {
  res.send("PharmaAI backend LIVE ✅");
});

// ✅ HEALTH CHECK
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// -------- AI RESPONSE --------
async function getAIResponse(prompt) {
  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content:
              "You are a warm, natural British pharmacy receptionist. Speak casually, short sentences, human tone."
          },
          { role: "user", content: prompt }
        ],
        max_tokens: 120,
        temperature: 0.7
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        }
      }
    );

    return resp.data.choices[0].message.content;
  } catch (err) {
    console.error("AI error:", err.message);
    return "Sorry… just a second… something went wrong.";
  }
}

// -------- ELEVENLABS TTS --------
async function generateSpeech(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`;

  const response = await axios.post(
    url,
    {
      text,
      model_id: "eleven_monolingual_v1",
      voice_settings: {
        stability: 0.35,
        similarity_boost: 0.7
      }
    },
    {
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY
      },
      responseType: "arraybuffer"
    }
  );

  const fileName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp3`;
  const filePath = path.join(TTS_DIR, fileName);

  fs.writeFileSync(filePath, response.data);

  return `${process.env.APP_BASE_URL}/tts/${fileName}`;
}

// Serve audio
app.get("/tts/:file", (req, res) => {
  const filePath = path.join(TTS_DIR, req.params.file);
  if (!fs.existsSync(filePath)) return res.sendStatus(404);

  res.setHeader("Content-Type", "audio/mpeg");
  res.sendFile(filePath);
});

// -------- TWILIO ENTRY --------
app.post("/incoming-call", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say("Hi… yeah, just a sec… you're through to the pharmacy… how can I help?");

  twiml.gather({
    input: "speech",
    action: "/process",
    method: "POST",
    speechTimeout: "auto"
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

// -------- PROCESS SPEECH --------
app.post("/process", async (req, res) => {
  const speech = req.body.SpeechResult || "";
  console.log("User:", speech);

  const twiml = new twilio.twiml.VoiceResponse();

  try {
    const aiReply = await getAIResponse(speech);
    const audioUrl = await generateSpeech(aiReply);

    twiml.play(audioUrl);

    // Continue conversation loop
    twiml.gather({
      input: "speech",
      action: "/process",
      method: "POST",
      speechTimeout: "auto"
    });

  } catch (err) {
    console.error(err);
    twiml.say("Sorry… something went wrong.");
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// -------- START SERVER --------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

