require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const OpenAI = require("openai");

const app = express();
app.use(express.urlencoded({ extended: true }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Health check
app.get("/health", (req, res) => {
  res.send("OK");
});

// AI function
async function getAIResponse(prompt) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are a warm, natural pharmacy receptionist.
Speak casually, short sentences, very human.

Help with:
- Appointments
- Medicine queries
- Urgent issues
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
    console.error(err);
    return "Sorry, something went wrong.";
  }
}

// Incoming call
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say("Hi, you’re through to the pharmacy. How can I help?");

  twiml.gather({
    input: "speech",
    action: "/process",
    method: "POST",
    speechTimeout: "auto"
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

// Process speech
app.post("/process", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const userSpeech = req.body.SpeechResult || "User said nothing";
  console.log("User:", userSpeech);

  const aiReply = await getAIResponse(userSpeech);

  twiml.say(aiReply);

  twiml.gather({
    input: "speech",
    action: "/process",
    method: "POST",
    speechTimeout: "auto"
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});

