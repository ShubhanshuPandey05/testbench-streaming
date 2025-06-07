const twilio = require('twilio');
require('dotenv').config();
const client = new twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
client.calls.create({
  url: 'https://temp-vb4k.onrender.com/voice', // Endpoint that returns TwiML instructions
  to: '+919664513886', // Recipient's phone number
  from: process.env.from// Your Twilio number
})
.then(call => console.log(call.sid));
// app.post('/voice', (req, res) => {
//   const twiml = new twilio.twiml.VoiceResponse();
//   twiml.say('Hello, you are speaking with the AI assistant.');
//   res.type('text/xml');
//   res.send(twiml.toString());
// });