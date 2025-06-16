const crypto = require('crypto');

const SECRET_KEY = 'your_super_secret_key';

function createSessionId(userId) {
    const timestamp = Date.now();
    const data = `${userId}:${timestamp}`;
    const hmac = crypto.createHmac('sha256', SECRET_KEY).update(data).digest('hex');
    const sessionId = `${userId}:${timestamp}:${hmac}`;
    return sessionId;
}

function verifySessionId(sessionId) {
    const [userId, timestamp, signature] = sessionId.split(':');
    if (!userId || !timestamp || !signature) return false;

    const data = `${userId}:${timestamp}`;
    const expectedHmac = crypto.createHmac('sha256', SECRET_KEY).update(data).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedHmac));
}
module.exports = { createSessionId, verifySessionId };


// const sessionId = createSessionId('123');
// console.log(sessionId);
// const isVerified = verifySessionId(sessionId);
// console.log(isVerified);
