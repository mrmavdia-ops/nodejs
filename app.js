require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const app = express();
app.use(express.urlencoded({ extended: true }));

// ===== AUDIO DIRECTORY FIX =====
const audioDir = path.join(__dirname, "public", "audio");
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
}

// Serve audio files
app.use("/audio", express.static(audioDir));

// ===== OPENAI SETUP =====
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== TWILIO SMS SETUP =====
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function sendSMS(to, message) {
  try {
    await client.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: to
    });
    console.log("✅ SMS sent");
  } catch (err) {
    console.error("❌ SMS error:", err.message);
  }
}

// ===== HEALTH CHECK =====
app.get("/health", (req, res) => {
  res.send("OK");
});

// ===== AI RESPONSE =====
async function getAIResponse(prompt) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are Emily, a real receptionist at a busy UK pharmacy.

You are speaking on a PHONE CALL.

Style:
- Natural, casual
- Short sentences
- Slightly busy tone
- Use fillers: "yeah...", "okay...", "just a sec..."
- Use pauses "..."
- Never sound like AI

Examples:
"Yeah... just a sec... yeah it's ready."
"Okay... we do have that in stock."
"Hmm... let me check that..."

Keep replies under 2 sentences.
          `
        },
        { role: "user", content: prompt }
      ]
    });

    return response.choices[0].message.content;

  } catch (err) {
    console.error("❌ AI error:", err.message);
    return "Sorry... just a sec...";
  }
}

// ===== ELEVENLABS VOICE =====
async function getVoiceFromElevenLabs(text) {
  try {
    console.log("🎤 Generating voice...");

    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
      {
        text: text,
        model_id: "eleven_turbo_v2",
        output_format: "mp3_44100_128",
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.85
        }
      },
      {
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json"
        },
        responseType: "arraybuffer",
        timeout: 10000
      }
    );

    if (!response.data || response.data.length === 0) {
      console.log("❌ Empty audio response");
      return null;
    }

    const fileName = `audio_${Date.now()}.mp3`;
    const filePath = path.join(audioDir, fileName);

    fs.writeFileSync(filePath, response.data);

    // ⚡ Faster delay
    await new Promise(resolve => setTimeout(resolve, 300));

    const baseUrl = process.env.APP_BASE_URL?.replace(/\/$/, "");
    const url = `${baseUrl}/audio/${fileName}`;

    console.log("🔊 Audio URL:", url);

    return url;

  } catch (err) {
    console.error("❌ ElevenLabs error:");
    console.error(err.response?.data || err.message);
    return null;
  }
}

// ===== INCOMING CALL =====
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  // ❌ NO ROBOTIC VOICE
  twiml.pause({ length: 1 });

  twiml.gather({
    input: "speech",
    action: "/process",
    method: "POST",
    speechTimeout: "auto"
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

// ===== PROCESS SPEECH =====
app.post("/process", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  console.log("---- PROCESS HIT ----");

  const userSpeech = req.body.SpeechResult || "";
  const callerNumber = req.body.From;

  console.log("User:", userSpeech);

  // If no speech
  if (!userSpeech) {
    twiml.say("Sorry... I didn't catch that...");
    twiml.gather({
      input: "speech",
      action: "/process",
      method: "POST",
      speechTimeout: "auto"
    });

    return res.type("text/xml").send(twiml.toString());
  }

  // AI + Voice
  const aiReply = await getAIResponse(userSpeech);
  const audioURL = await getVoiceFromElevenLabs(aiReply);

  // 📩 SEND SMS
  if (callerNumber) {
    await sendSMS(
      callerNumber,
      `Hi, thanks for calling. ${aiReply}`
    );
  }

  // 🔊 PLAY VOICE
  if (audioURL) {
    twiml.play(audioURL);
  } else {
    console.log("⚠️ Fallback to Twilio voice");
    twiml.say(aiReply);
  }

  // Continue conversation
  twiml.gather({
    input: "speech",
    action: "/process",
    method: "POST",
    speechTimeout: "auto"
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});
