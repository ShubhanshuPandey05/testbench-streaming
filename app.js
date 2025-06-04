// server.js

const express = require('express');
const bodyParser = require('body-parser');
const { twiml } = require('twilio');

const app = express();
const PORT = process.env.PORT || 3000;

// Parse incoming POST data as URL-encoded (Twilio sends data this way)
app.use(bodyParser.urlencoded({ extended: false }));

// Twilio webhook endpoint
app.post('/voice', (req, res) => {
  const response = new twiml.VoiceResponse();
  const connect = response.connect();
  connect.stream({ url: 'wss://218f-137-97-211-170.ngrok-free.app' });
  // response.start().stream({ url: 'wss://a31a-2401-4900-1c80-9450-6c61-8e74-1d49-209a.ngrok-free.app', track:'both' });
  response.say('Connecting you to the AI assistant.');
  // response.pause({ length: 60 })
  res.type('text/xml');
  res.send(response.toString());
});

// Basic health check
app.get('/', (req, res) => {
  res.send('Twilio Voice Webhook Server is running!');
});

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});