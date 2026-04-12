// server.cjs – ReceptX Real-Time Voice Assistant
require('dotenv').config();
const express = require('express');
const http = require('http');
const twilio = require('twilio');
const { WebSocketServer } = require('ws');
const { Deepgram } = require('@deepgram/sdk');
const OpenAI = require('openai');
const axios = require('axios');
//const chrono = require('chrono-node');
const { CronJob } = require('cron');
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // for Twilio status callbacks
// --- Environment Setup ---
const PORT = process.env.PORT || 3000;
const TWILIO_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const deepgram = new Deepgram(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const elevenKey = process.env.ELEVENLABS_API_KEY;
const elevenVoiceId = process.env.ELEVENLABS_VOICE_ID;
const twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
// In-memory appointments (production: replace with DB)
let appointments = []; // {id, phone, date}
// System prompt for OpenAI
const SYSTEM_PROMPT = `
You are Emma, receptionist at ReceptX Pharmacy. Speak in a natural British tone using short, polite sentences.
Rules:
- Do not repeat greetings or say "How can I help you".
- Handle booking/cancelation requests.
- Example: "I’d like to book an appointment for [date]".
- If unclear: say "Yeah... just a sec... let me check that."
`;
// --- Routes ---
// Health check
app.get('/', (req, res) => res.send('ReceptX Voice Assistant Running 🚀'));
// Twilio Voice webhook: start bidirectional stream
app.post('/voice', (req, res) => {
const twiml = new twilio.twiml.VoiceResponse();
const connect = twiml.connect();
// Start bidirectional media stream
connect.stream({ url: `wss://${req.headers.host}/stream` });
// Twilio requires a closing tag; we add a Say for completeness
twiml.say('Connecting you to ReceptX AI assistant.');
res.type('text/xml');
res.send(twiml.toString());
});
// Optional: handle SMS webhook if needed (not required here)
// Twilio status callback (for logging)
app.post('/events', (req, res) => {
console.log('Event:', req.body);
res.sendStatus(200);
});
// --- Server + WebSocket ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
console.log('🔌 Twilio connected: new stream');
// Deepgram real-time transcription
const dgConnection = deepgram.transcription.live({
model: 'nova-2', language: 'en-GB', smart_format: true
});
dgConnection.addListener('open', () => console.log('🎤 Deepgram stream open'));
dgConnection.addListener('transcriptReceived', async (data) => {
const transcript = data.channel.alternatives[0].transcript.trim();
if (!transcript || transcript.length < 6) return;
console.log('User said:', transcript);
// Appointment handling flags
let aiReply = '';
let handled = false;
// Check for booking intent
if (/book|schedule|appointment/i.test(transcript)) {
// Parse date (naive example)
const date = chrono.parseDate(transcript) || new Date(Date.now() + 86400000);
const appt = { id: Date.now(), phone: data.caller, date };
appointments.push(appt);
aiReply = `Your appointment is confirmed for ${date.toLocaleString('en-GB')}.`;
console.log('Appointment booked for', date);
// Send SMS confirmation
twilioClient.messages.create({
from: TWILIO_NUMBER,
to: data.caller,
body: `ReceptX: Appointment confirmed for ${date.toLocaleString('en-GB')}.`
}).catch(err => console.error('SMS error:', err.message));
handled = true;
}
// Check for cancel intent
if (!handled && /cancel/i.test(transcript)) {
// Cancel all appointments for this caller (simple approach)
appointments = appointments.filter(a => a.phone !== data.caller);
aiReply = "Your appointment has been cancelled.";
console.log('Appointment cancelled for', data.caller);
// Send SMS cancellation
twilioClient.messages.create({
from: TWILIO_NUMBER,
to: data.caller,
body: `ReceptX: Your appointment has been cancelled.`
}).catch(err => console.error('SMS error:', err.message));
handled = true;
}
// Otherwise, get AI response
if (!handled) {
try {
const completion = await openai.chat.completions.create({
model: 'gpt-4o-mini',
temperature: 0.5,
max_tokens: 50,
messages: [
{ role: 'system', content: SYSTEM_PROMPT },
{ role: 'user', content: transcript }
]
});
aiReply = completion.choices[0].message.content;
} catch (err) {
console.error('OpenAI error:', err.message);
aiReply = "Yeah... just a sec... let me check that.";
}
}
console.log('AI reply:', aiReply);
// Stream TTS audio with ElevenLabs
try {
const response = await axios({
method: 'POST',
url: `https://api.elevenlabs.io/v1/text-to-speech/${elevenVoiceId}/stream`,
data: {
text: aiReply,
model_id: 'eleven_turbo_v2',
output_format: 'ulaw_8000', // required by Twilio
optimize_streaming_latency: 4,
voice_settings: { stability: 0.4, similarity_boost: 0.85 }
},
headers: { 'xi-api-key': elevenKey },
responseType: 'stream'
});
response.data.on('data', chunk => {
ws.send(JSON.stringify({
event: 'media',
media: { payload: chunk.toString('base64') }
}));
});
} catch (err) {
console.error('ElevenLabs error:', err.message);
}
});
// Forward Twilio audio to Deepgram
ws.on('message', msg => {
const data = JSON.parse(msg);
if (data.event === 'media') {
const audioBuffer = Buffer.from(data.media.payload, 'base64');
dgConnection.send(audioBuffer);
}
});
ws.on('close', () => {
dgConnection.finish();
console.log('❌ Twilio disconnected (stream closed)');
});
ws.on('error', err => {
console.error('WebSocket error:', err.message);
});
});
server.listen(PORT, () => {
console.log(`Server running on port ${PORT}`);
});
