// app.js
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const twilio = require("twilio");
const { Deepgram } = require("@deepgram/sdk");

const app = express();
const PORT = process.env.PORT || 3000;

const TTS_DIR = path.join(__dirname, "tmp_tts");
if (!fs.existsSync(TTS_DIR)) fs.mkdirSync(TTS_DIR, { recursive: true });

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

const deepgram = process.env.DEEPGRAM_API_KEY ? new Deepgram(process.env.DEEPGRAM_API_KEY) : null;

// Helpers
function splitIntoChunks(text) {
  return text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function cleanupOldFiles(cutoffMs = 10 * 60 * 1000) {
  try {
    const files = fs.readdirSync(TTS_DIR);
    const now = Date.now();
    files.forEach(f => {
      const p = path.join(TTS_DIR, f);
      const st = fs.statSync(p);
      if (now - st.mtimeMs > cutoffMs) fs.unlinkSync(p);
    });
  } catch (e) {
    console.error("cleanup error", e);
  }
}

// OpenAI text response
async function getAIResponse(prompt) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY");
  }
  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: "You are a warm, professional pharmacy receptionist. Keep responses concise, human, and friendly." },
          { role: "user", content: prompt }
        ],
        max_tokens: 180,
        temperature: 0.7
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 20000
      }
    );
    return resp.data.choices?.[0]?.message?.content?.trim() || "Sorry, I couldn't prepare a response right now.";
  } catch (err) {
    console.error("OpenAI error:", err?.response?.data || err.message);
    return "I am sorry, I can't respond at the moment.";
  }
}

// ElevenLabs TTS -> save locally and return public URL
async function generateSpeechAndServe(text) {
  if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_VOICE_ID) {
    throw new Error("Missing ElevenLabs keys");
  }
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`;
  const body = {
    text,
    model_id: "eleven_monolingual_v1",
    voice_settings: {
      stability: parseFloat(process.env.ELEVENLABS_STABILITY || "0.35"),
      similarity_boost: parseFloat(process.env.ELEVENLABS_SIMILARITY || "0.6")
    }
  };

  const resp = await axios.post(url, body, {
    headers: {
      "xi-api-key": process.env.ELEVENLABS_API_KEY,
      "Content-Type": "application/json"
    },
    responseType: "arraybuffer",
    timeout: 20000
  });

  const audioBuffer = Buffer.from(resp.data);
  const id = crypto.randomBytes(8).toString("hex");
  const filename = `${Date.now()}-${id}.mp3`;
  const filepath = path.join(TTS_DIR, filename);
  fs.writeFileSync(filepath, audioBuffer);
  // cleanup in background
  cleanupOldFiles();
  const base = process.env.APP_BASE_URL || process.env.HOST_URL || "";
  if (!base) {
    // Serve relative path (useful for local testing with ngrok/APP_BASE_URL set)
    return `/tts/${filename}`;
  }
  return `${base.replace(/\/$/, "")}/tts/${filename}`;
}

// Serve tts files
app.get("/tts/:file", (req, res) => {
  const file = req.params.file;
  const filepath = path.join(TTS_DIR, file);
  if (!fs.existsSync(filepath)) return res.status(404).send("Not found");
  res.setHeader("Content-Type", "audio/mpeg");
  res.sendFile(filepath);
});

// Health
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Twilio: incoming call webhook
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("Hello. Welcome to PharmaAI. Press 1 for office hours, 2 for pharmacy location, or hold to speak to an agent.");
  twiml.gather({ numDigits: 1, action: "/handle-input", method: "POST", timeout: 5 });
  // fallback: record a short message (if no digit)
  twiml.record({ maxLength: 20, action: "/recording", recordingStatusCallback: "/recording", playBeep: true });
  res.type("text/xml").send(twiml.toString());
});

// Handle digit input live in-call: get AI text and play TTS chunks
app.post("/handle-input", async (req, res) => {
  const digits = req.body.Digits || "";
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    const prompt = `Caller pressed: ${digits}. As a warm professional pharmacy receptionist, produce a brief spoken reply tailored to this option. Keep sentences short and natural.`;
    const aiText = await getAIResponse(prompt);
    const chunks = splitIntoChunks(aiText);

    for (let i = 0; i < chunks.length; i++) {
      const audioUrl = await generateSpeechAndServe(chunks[i]);
      // Twilio <Play> needs full URL when in production; if APP_BASE_URL is set to public url it will be full.
      twiml.play({}, audioUrl);
      if (i < chunks.length - 1) twiml.pause({ length: 1 }); // 1s pause between sentences
    }

    twiml.say("If you need more help, press 0 to speak to a pharmacist, or hang up.");
    twiml.gather({ numDigits: 1, action: "/handle-input", method: "POST", timeout: 5 });
  } catch (err) {
    console.error("handle-input error:", err);
    twiml.say("Sorry, there was an error. Please try again later.");
    twiml.hangup();
  }

  res.type("text/xml").send(twiml.toString());
});

// Twilio recording callback: download recording, transcribe with Deepgram, process asynchronously
app.post("/recording", async (req, res) => {
  // Twilio posts RecordingUrl, RecordingSid, CallSid, etc.
  const recordingUrl = req.body.RecordingUrl; // often without extension
  const recordingSid = req.body.RecordingSid;
  const callSid = req.body.CallSid;

  // Immediately acknowledge Twilio
  res.sendStatus(200);

  if (!recordingUrl) {
    console.warn("No recordingUrl provided in callback");
    return;
  }

  try {
    // Append .wav to get WAV file from Twilio media (works in most setups)
    const wavUrl = `${recordingUrl}.wav`;
    const twilioResp = await axios.get(wavUrl, {
      responseType: "arraybuffer",
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID || "",
        password: process.env.TWILIO_AUTH_TOKEN || ""
      },
      timeout: 30000
    });
    const audioBuffer = Buffer.from(twilioResp.data);

    let transcript = "";
    if (deepgram) {
      const dgResp = await deepgram.transcription.preRecorded(
        { buffer: audioBuffer },
        { punctuate: true, language: "en-US" }
      );
      transcript = dgResp?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    }

    // Optionally: call OpenAI for further processing
    const aiText = await getAIResponse(`Caller said: ${transcript}. Provide a concise assistant response.`);

    // Generate TTS (and upload/serve) - we store the TTS for later use in dashboard/agent
    const ttsUrl = await generateSpeechAndServe(aiText);

    // TODO: persist call record (callSid, recordingSid, transcript, aiText, ttsUrl) to your DB per tenant
    console.log("Recording processed:", { callSid, recordingSid, transcript, aiText, ttsUrl });
  } catch (err) {
    console.error("Error processing recording callback:", err?.response?.data || err.message);
  }
});

// Error handler and start
app.use((err, req, res, next) => {
  console.error("Unhandled Error:", err);
  res.status(500).json({ error: "Internal Server Error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ PharmaAI Receptionist running on 0.0.0.0:${PORT}`);
  console.log(`📍 APP_BASE_URL=${process.env.APP_BASE_URL || "(not set)"} -- set this to your public URL (Railway/ngrok) for Twilio to fetch TTS files`);
});
