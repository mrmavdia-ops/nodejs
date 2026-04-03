require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const app = express();
app.use(express.urlencoded({ extended: true }));

// Ensure audio folder exists
const audioDir = path.join(__dirname, "public", "audio");
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
}

// Serve audio files
app.use("/audio", express.static(audioDir));

// OpenAI setup
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Health check
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
You are Emily, a young British pharmacy receptionist.

Speak:
- Natural, casual, human
- Short sentences
- Friendly and slightly busy tone

Never sound robotic.
          `
        },
        { role: "user", content: prompt }
      ]
    });

    return response.choices[0].message.content;

  } catch (err) {
    console.error("AI error:", err.message);
    return "Sorry… just a second… something went wrong.";
  }
}


// ===== ELEVENLABS VOICE =====
async function getVoiceFromElevenLabs(text) {
  try {
    console.log("Generating voice...");

    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
      {
        text: text,
        model_id: "eleven_monolingual_v1",
        voice_settings: {
          stability: 0.35,
          similarity_boost: 0.75
        }
      },
      {
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json"
        },
        responseType: "arraybuffer"
      }
    );

    const fileName = `audio_${Date.now()}.mp3`;
    const filePath = path.join(audioDir, fileName);

    fs.writeFileSync(filePath, response.data);

    console.log("Saved file:", filePath);

    // Delay so Twilio can fetch
    await new Promise(resolve => setTimeout(resolve, 1200));

    const baseUrl = process.env.APP_BASE_URL?.replace(/\/$/, "");
    const url = `${baseUrl}/audio/${fileName}`;

    console.log("FINAL AUDIO URL:", url);

    return url;

  } catch (err) {
    console.error("ElevenLabs error:", err.response?.data || err.message);
    return null;
  }
}


// ===== INCOMING CALL =====
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
const greeting = "Hi...its Emma lloyds Pharmacy how can i help";
  const audioURL = await getVoiceFromEleveblabs(greeting);
  if (audioURL){
    twiml.play(audioURL);
  } else {
    twiml.say(greeting);
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


// ===== STEP 1: FAST RESPONSE (NO TIMEOUT) =====
app.post("/process", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  console.log("---- PROCESS HIT ----");

  const userSpeech = req.body.SpeechResult || "";
  console.log("User:", userSpeech);

  // If no speech → ask again
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

  // 🔥 AI + Voice
  const aiReply = await getAIResponse(userSpeech);
  const audioURL = await getVoiceFromElevenLabs(aiReply);

  if (audioURL) {
    twiml.play(audioURL);
  } else {
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
  console.log("Server running on port " + PORT);
});
