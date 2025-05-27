const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const config = require('./config/config');
const sessionManager = require('./services/SessionManager');
const audioProcessor = require('./services/AudioProcessor');
const deepgramService = require('./services/DeepgramService');

// Initialize WebSocket server
const wss = new WebSocket.Server({ port: config.WS_PORT });
console.log(`✅ WebSocket server started on ws://localhost:${config.WS_PORT}`);

// Set up session cleanup interval
setInterval(() => {
    sessionManager.cleanupInactiveSessions(config.SESSION_CONFIG.maxInactiveTime);
}, config.SESSION_CONFIG.cleanupInterval);

wss.on('connection', (ws) => {
    const sessionId = uuidv4();
    console.log(`🎧 Client connected with session ID: ${sessionId}`);
    
    // Create new session
    const session = sessionManager.createSession(sessionId);
    
    // Initialize Deepgram connection
    session.dgSocket = deepgramService.createConnection(session, ws);

    // Handle incoming messages
    ws.on('message', (message) => {
        try {
            // Check if the message is binary (audio data)
            if (message instanceof Buffer) {
                // Process audio data directly
                audioProcessor.processAudio(message);
                // Update session activity
                sessionManager.updateSessionActivity(sessionId);
                return;
            }

            // Try to parse as JSON for control messages
            try {
                const data = JSON.parse(message.toString());
                
                // Handle different types of JSON messages
                switch (data.type) {
                    case 'audio':
                        if (data.audio) {
                            audioProcessor.processAudio(Buffer.from(data.audio, 'base64'));
                        }
                        break;
                    case 'control':
                        // Handle control messages
                        console.log('Control message received:', data);
                        break;
                    default:
                        console.log('Unknown message type:', data.type);
                }
            } catch (jsonError) {
                // If it's not valid JSON, it might be raw audio data
                audioProcessor.processAudio(message);
            }
            
            // Update session activity
            sessionManager.updateSessionActivity(sessionId);
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });

    // Handle client disconnection
    ws.on('close', () => {
        console.log(`Client disconnected: ${sessionId}`);
        sessionManager.removeSession(sessionId);
    });

    // Handle errors
    ws.on('error', (error) => {
        console.error(`WebSocket error for session ${sessionId}:`, error);
        sessionManager.removeSession(sessionId);
    });
});

// Handle process termination
process.on('SIGINT', () => {
    console.log('Shutting down server...');
    audioProcessor.cleanup();
    wss.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
}); 