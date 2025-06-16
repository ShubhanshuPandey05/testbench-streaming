const axios = require('axios');
const twilio = require('twilio');
require('dotenv').config();
const client = new twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

let phoneNo = []

async function getAllUsersAndCallThem() {
    try {
        const response = await axios.get('http://localhost:3000/getallusers'); // Your full user endpoint
        const users = response.data;

        console.log('📱 Calling All the Users:');
        users.forEach((user, index) => {
            const phone = user.phone || '(no phone)';
            phoneNo.push(phone)
            //   console.log(`${index + 1}. ${user.name || 'Unknown'} - ${phone}`);
        });

        
        for (let i = 0; i < phoneNo.length; i++) {
            setTimeout(() => {
                console.log(`Calling ${phoneNo[i]} at index ${i}`);
                client.calls.create({
                    url: 'https://temer.com/voice',
                    to: phoneNo[i],
                    from: "+16812215320"
                })
                    .then(call => console.log(`Call initiated for ${phoneNo[i]}`))
                    .catch(err => console.error(`Failed to call ${phoneNo[i]}:`, err));
            }, i * 3000); // Delay increases with each iteration
        }



    } catch (error) {
        console.error('❌ Error fetching users:', error.message);
    }
}

getAllUsersAndCallThem();
