const WebSocket = require('ws');
const { createClient } = require('@deepgram/sdk');
const config = require('../config/config');

class DeepgramService {
    constructor() {
        this.client = createClient(process.env.DEEPGRAM_API);
    }

    createConnection(session, ws) {
        const dgSocket = new WebSocket(
            `wss://api.deepgram.com/v1/listen?${this.buildQueryString(config.DEEPGRAM_CONFIG)}`,
            ['token', `${process.env.DEEPGRAM_API}`]
        );

        dgSocket.on('open', () => {
            console.log(`✅ Deepgram WebSocket connected for session ${session.sessionId}`);
            session.reconnectAttempts = 0;
        });

        dgSocket.on('message', async (data) => {
            try {
                const received = JSON.parse(data);
                if (received.channel?.alternatives?.[0]?.transcript) {
                    const transcript = received.channel.alternatives[0].transcript;
                    const confidence = received.channel?.alternatives?.[0]?.confidence || 0;
                    const now = Date.now();

                    // Handle interim results
                    if (!received.is_final) {
                        if (this.shouldProcessInterim(confidence, now, session)) {
                            session.isSpeaking = true;
                            session.lastInterimTime = now;
                            session.lastInterimTranscript = transcript;
                            session.interimResultsBuffer.push(transcript);

                            ws.send(JSON.stringify({
                                transcript: transcript,
                                isInterim: true
                            }));
                        }
                        return;
                    }

                    // Handle final results
                    if (received.is_final) {
                        this.handleFinalResult(session, transcript, ws);
                    }
                }
            } catch (error) {
                console.error('Error processing Deepgram message:', error);
            }
        });

        dgSocket.on('close', () => {
            console.log(`Deepgram WebSocket closed for session ${session.sessionId}`);
            this.handleReconnect(session, ws);
        });

        dgSocket.on('error', (error) => {
            console.error(`Deepgram WebSocket error for session ${session.sessionId}:`, error);
        });

        return dgSocket;
    }

    buildQueryString(config) {
        return Object.entries(config)
            .map(([key, value]) => `${key}=${value}`)
            .join('&');
    }

    shouldProcessInterim(confidence, now, session) {
        return confidence >= config.SPEECH_CONFIG.interimConfidenceThreshold &&
            (now - session.lastInterimTime >= config.SPEECH_CONFIG.interimTimeThreshold) &&
            (session.isSpeaking || session.lastInterimTranscript.length > 2) &&
            session.lastInterimTranscript !== session.lastInterimTranscript;
    }

    handleFinalResult(session, transcript, ws) {
        session.isSpeaking = false;
        session.lastInterimTranscript = '';
        session.interimResultsBuffer = [];

        if (session.silenceTimer) {
            clearTimeout(session.silenceTimer);
            session.silenceTimer = null;
        }

        if (transcript !== session.lastTranscript) {
            session.transcriptBuffer.push(transcript);
            session.lastTranscript = transcript;
        }

        if (session.transcriptBuffer.length > 0) {
            const finalTranscript = session.transcriptBuffer.join(' ');
            console.log('Final transcript before LLM:', finalTranscript);

            ws.send(JSON.stringify({
                transcript: finalTranscript,
                isFinal: true
            }));
        }
    }

    handleReconnect(session, ws) {
        if (session.reconnectAttempts < 5) {
            session.reconnectAttempts++;
            console.log(`Attempting to reconnect Deepgram (attempt ${session.reconnectAttempts})`);
            setTimeout(() => {
                session.dgSocket = this.createConnection(session, ws);
            }, 1000 * session.reconnectAttempts);
        } else {
            console.error('Max reconnection attempts reached');
            ws.close();
        }
    }
}

module.exports = new DeepgramService(); 