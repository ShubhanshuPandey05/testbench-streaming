const twilio = require('twilio');
require('dotenv').config();
const client = new twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
client.calls.create({
  url: 'https://temp-vb4k.onrender.com/voice', // Endpoint that returns TwiML instructions
  // to: "+918780899485", // Recipient's phone number
  to: "+919313562780", // Recipient's phone number
  from: "+16812215320"// Your Twilio number
})
.then(call => console.log(call.sid));