const express = require("express");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");
const axios = require("axios");
require("dotenv").config();

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

