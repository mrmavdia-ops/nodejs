require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
 

const app = express();
app.use(express.urlencoded({ extended: true }));

// Serve audio files
app.use("/audio", express.static("public/audio"));

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

Help with:
- Prescription status
- Medicine availability
- Appointments
- Opening hours
- General queries

Never sound robotic.
          `
        },
        {
          role: "user",
          content: prompt
        }
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
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLAB_VOICE_ID}`,
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
          "xi-api-key": process.env.ELEVENLAB_API_KEY,
          "Content-Type": "application/json"
        },
        responseType: "arraybuffer"
      }
    );

    const fileName = `audio_${Date.now()}.mp3`;
    const filePath = path.join(__dirname, "public","audio", fileName);

    fs.writeFileSync(filePath, response.data);

    return `${process.env.APP_BASE_URL}/audio/${fileName}`;

  } catch (err) {
    console.error("ElevenLabs error:", err.message);
    return null;
  }
}


// ===== INCOMING CALL =====
app.post("/voice", (req, res) => {
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


// ===== PROCESS SPEECH =====
app.post("/process", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const userSpeech = req.body.SpeechResult || "Hello";
  console.log("User:", userSpeech);

  // AI response
  const aiReply = await getAIResponse(userSpeech);

  // Convert to human voice
  const audioURL = await getVoiceFromElevenLabs(aiReply);

  if (audioURL) {
    twiml.play(audioURL);
  } else {
    twiml.say(aiReply); // fallback if ElevenLabs fails
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
