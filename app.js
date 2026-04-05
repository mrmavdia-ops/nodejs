
require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const app = express();
app.use(express.urlencoded({ extended: true }));

// ===== AUDIO DIRECTORY =====
const audioDir = path.join(__dirname, "public", "audio");
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
}

app.use("/audio", express.static(audioDir));

// ===== OPENAI =====
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== TWILIO =====
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ===== HEALTH =====
app.get("/health", (req, res) => {
  res.send("OK");
});


// ===== SYSTEM PROMPT (YOUR LOGIC - OPTIMISED) =====
const SYSTEM_PROMPT = `
You are the Receptionist for Lloyds Pharmacy, Oldham.

Handle calls independently. Reduce staff interruptions.

Speak:
- Natural British tone
- Short responses (max 1–2 sentences)
- Slightly busy, human

Rules:
- NEVER ask for phone number
- Caller is already identified
- Do NOT repeat greetings
- Minimise transfers
- Offer SMS whenever useful

Behaviour:
- Handle prescriptions, delivery, stock, hours, services
- If unsure or use fillers like : "Yeah... just a sec... let me check that"

Prescription status:
- pending → "Your prescription is still being prepared."
- ready → "Your prescription is ready for collection."
- delivery → "Your prescription will be delivered shortly."

If caller insists on staff:
Ask once → offer help
Ask twice → offer SMS
Third time → allow transfer

Never give medical advice.
Never sound robotic.
`;


// ===== AI RESPONSE =====
async function getAIResponse(prompt) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.6,
      max_tokens: 60,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt }
      ]
    });

    return response.choices[0].message.content;

  } catch (err) {
    console.error("AI error:", err.message);
    return "Yeah... just a sec...";
  }
}


// ===== ELEVENLABS =====
async function getVoiceFromElevenLabs(text) {
  try {
    const response = await axios.post(
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
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json"
        },
        responseType: "arraybuffer",
        timeout: 8000
      }
    );

    const fileName = `audio_${Date.now()}.mp3`;
    const filePath = path.join(audioDir, fileName);

    fs.writeFileSync(filePath, response.data);

    const baseUrl = process.env.APP_BASE_URL?.replace(/\/$/, "");
    return `${baseUrl}/audio/${fileName}`;

  } catch (err) {
    console.error("ElevenLabs error:", err.message);
    return null;
  }
}


// ===== SEND SMS =====
async function sendSMS(to, message) {
  try {
    await client.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: to
    });
    console.log("SMS sent");
  } catch (err) {
    console.error("SMS error:", err.message);
  }
}


// ===== VOICE ENTRY =====
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = process.env.APP_BASE_URL?.replace(/\/$/, "");

  // 🎤 INSTANT HUMAN GREETING
  twiml.play(`${baseUrl}/audio/greeting.mp3`);

  twiml.gather({
    input: "speech",
    action: "/process",
    method: "POST",
    speechTimeout: "auto"
  });

  res.type("text/xml");
  res.send(twiml.toString());
});


// ===== PROCESS =====
app.post("/process", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const userSpeech = req.body.SpeechResult || "";
  const caller = req.body.From;

  console.log("User:", userSpeech);

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

  // ⚡ FAST AI RESPONSE
  const aiReply = await getAIResponse(userSpeech);

  // ⚡ INSTANT SPEECH (NO DELAY)
  twiml.say(aiReply
           );

  // 🔥 BACKGROUND VOICE GENERATION
  getVoiceFromElevenLabs(aiReply);

  // 📩 SMS TRIGGER (example logic)
  if (userSpeech.toLowerCase().includes("prescription")) {
    setTimeout(() => {
      sendSMS(
        caller,
        `Update: ${aiReply}`
      );
    }, 3000);
  }

  twiml.gather({
    input: "speech",
    action: "/process",
    method: "POST",
    speechTimeout: "auto"
  });

  res.type("text/xml");
  res.send(twiml.toString());
});


// ===== INCOMING SMS =====
app.post("/sms", (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  const msg = req.body.Body;
  console.log("Incoming SMS:", msg);

  twiml.message("Thanks, we’ll update you shortly.");

  res.type("text/xml");
  res.send(twiml.toString());
});


// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});

