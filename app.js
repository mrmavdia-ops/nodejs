require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const app = express();
app.use(express.urlencoded({ extended: true }));

// ===== AUDIO DIR =====
const audioDir = path.join(__dirname, "public", "audio");
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
}
app.use("/audio", express.static(audioDir));

// ===== CLIENTS =====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ===== PROMPT =====
const SYSTEM_PROMPT = `
You are Emily, a British pharmacy receptionist.

Speak naturally:
- Short sentences
- Clear pronunciation
- Friendly, slightly busy

Rules:
- Never ask phone number
- Do not repeat greetings
- Be direct and helpful
- Correct spelling always

If unsure:
"Yeah... just a sec... let me check that"
`;

// ===== AI =====
async function getAIResponse(prompt) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.4,
      max_tokens: 40,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt }
      ]
    });

    return response.choices[0].message.content;

  } catch (err) {
    console.error(err);
    return "Yeah... just a sec...";
  }
}

// ===== ELEVENLABS =====
async function generateVoice(text) {
  try {
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
      {
        text,
        model_id: "eleven_turbo_v2",
        output_format: "mp3_44100_128",
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.85
        }
      },
      {
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY
        },
        responseType: "arraybuffer"
      }
    );

    const file = `audio_${Date.now()}.mp3`;
    const filePath = path.join(audioDir, file);

    fs.writeFileSync(filePath, res.data);

    return `${process.env.APP_BASE_URL}/audio/${file}`;

  } catch (err) {
    console.error("TTS error:", err.message);
    return null;
  }
}

// ===== SMS =====
async function sendSMS(to, msg) {
  try {
    await client.messages.create({
      body: msg,
      from: process.env.TWILIO_PHONE_NUMBER,
      to
    });
  } catch (e) {
    console.log("SMS error:", e.message);
  }
}

// ===== ENTRY =====
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const base = process.env.APP_BASE_URL;

  // 🔥 INSTANT HUMAN GREETING (pre-generated MP3)
  twiml.play(`${base}/audio/greeting.mp3`);

  twiml.gather({
    input: "speech",
    action: "/process",
    method: "POST",
    speechTimeout: "auto"
  });

  res.type("text/xml").send(twiml.toString());
});

// ===== PROCESS =====
app.post("/process", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const base = process.env.APP_BASE_URL;

  const userSpeech = req.body.SpeechResult || "";
  const caller = req.body.From;

  console.log("User:", userSpeech);

  if (!userSpeech) {
    twiml.play(`${base}/audio/repeat.mp3`);
    twiml.gather({ input: "speech", action: "/process" });
    return res.type("text/xml").send(twiml.toString());
  }

  // 🔥 STEP 1: PLAY FILLER (NO SILENCE)
  twiml.play(`${base}/audio/thinking.mp3`);

  // 🔥 STEP 2: REDIRECT (async processing)
  twiml.redirect({
    method: "POST"
  }, `/respond?text=${encodeURIComponent(userSpeech)}&from=${caller}`);

  res.type("text/xml").send(twiml.toString());
});

// ===== FINAL RESPONSE =====
app.post("/respond", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const userSpeech = req.query.text;
  const caller = req.query.from;

  const aiReply = await getAIResponse(userSpeech);
  const audio = await generateVoice(aiReply);

  if (audio) {
    twiml.play(audio);
  } else {
    twiml.say("Sorry, something went wrong.");
  }

  // SMS trigger
  if (userSpeech.toLowerCase().includes("prescription")) {
    sendSMS(caller, `Update: ${aiReply}`);
  }

  twiml.gather({
    input: "speech",
    action: "/process",
    method: "POST",
    speechTimeout: "auto"
  });

  res.type("text/xml").send(twiml.toString());
});

// ===== SMS IN =====
app.post("/sms", (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message("Got it. We'll update you shortly.");
  res.type("text/xml").send(twiml.toString());
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Running on port", PORT);
});

