// Core Dependencies
const { spawn } = require('child_process');
const WebSocket = require('ws');
require('dotenv').config(); // Make sure your .env file has all the necessary keys
const { PollyClient, SynthesizeSpeechCommand } = require("@aws-sdk/client-polly");
const OpenAI = require("openai");
const twilio = require('twilio'); // This might not be directly used in the WebSocket server, but kept for consistency
const fs = require('fs'); // Not used in this version, but kept for consistency

// Configuration Constants
const CONFIG = {
    MAX_RECONNECT_ATTEMPTS: 5,
    RECONNECT_DELAY: 1000,
    // SILENCE_THRESHOLD: 500, // Not actively used in this VAD logic, but kept
    // INTERIM_CONFIDENCE_THRESHOLD: 0.7, // No longer used for immediate interim sending
    // INTERIM_TIME_THRESHOLD: 10, // No longer used for immediate interim sending
    // CHUNK_SIZE: 6400, // No longer used for Deepgram streaming, replaced by DEEPGRAM_STREAM_CHUNK_SIZE
    AUDIO_CHUNK_SIZE: 1600, // Mulaw audio chunk size for Twilio (8khz) - This is for sending to Twilio
    DEEPGRAM_STREAM_CHUNK_SIZE: 1600, // 100ms of 16khz s16le audio for Deepgram (16000 samples/s * 0.1s * 2 bytes/sample)
    SAMPLE_RATE: 16000, // Sample rate for Deepgram and internal processing (linear16)
    AUDIO_SAMPLE_RATE: 8000, // Sample rate for Twilio (mulaw)
    POLLY_VOICE_ID: "Joanna",
    POLLY_OUTPUT_FORMAT: "mp3",
    GPT_MODEL: "gpt-4o-mini",
    GPT_MAX_TOKENS: 150,
    GPT_TEMPERATURE: 0.1
};

// Service Initialization
const services = {
    twilio: new twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN),
    polly: new PollyClient({
        region: "us-east-1",
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
    }),
    openai: new OpenAI({ apiKey: process.env.OPEN_AI_API_KEY })
};

// Performance Monitoring (Global, as it aggregates stats from all sessions)
const performance = {
    latency: {
        total: 0,
        count: 0,
        min: Infinity,
        max: 0,
        lastUpdate: Date.now()
    },
    updateStats: function (latency) {
        this.latency.total += latency;
        this.latency.count++;
        this.latency.min = Math.min(this.latency.min, latency);
        this.latency.max = Math.max(this.latency.max, latency);

        const now = Date.now();
        if (now - this.latency.lastUpdate >= 5000) {
            const avg = this.latency.total / this.latency.count;
            console.log('\n=== Global Performance Metrics ===');
            console.log(`Average Latency: ${avg.toFixed(2)}ms`);
            console.log(`Min Latency: ${this.latency.min.toFixed(2)}ms`);
            console.log(`Max Latency: ${this.latency.max.toFixed(2)}ms`);
            console.log(`Total Samples: ${this.latency.count}`);
            console.log('==================================\n');

            this.latency.total = 0;
            this.latency.count = 0;
            this.latency.min = Infinity;
            this.latency.max = 0;
            this.latency.lastUpdate = now;
        }
    }
};

// Session Management
class SessionManager {
    constructor() {
        this.sessions = new Map(); // Stores active sessions by streamSid
    }

    createSession(sessionId, ws) {
        if (this.sessions.has(sessionId)) {
            console.warn(`Session ${sessionId}: already exists, re-creating.`);
            this.cleanupSession(sessionId); // Clean up existing one if it somehow exists
        }

        const session = {
            id: sessionId,
            ws: ws, // Store the Twilio WebSocket for sending media
            dgSocket: null, // Deepgram WebSocket
            reconnectAttempts: 0,
            lastTranscript: '',
            transcriptBuffer: [],
            // silenceTimer: null, // Not used with current VAD/Deepgram approach
            audioStartTime: null, // For latency measurement
            lastInterimTime: Date.now(),
            isSpeaking: false, // User speaking status from Deepgram's perspective
            lastInterimTranscript: '',
            interimResultsBuffer: [],
            userSpeak: false, // Flag when user has finished speaking
            streamSid: sessionId,
            callSid: '', // Will be populated from Twilio 'start' event
            isAIResponding: false, // AI currently speaking
            currentAudioStream: null, // Reference to the outgoing audio stream function
            interruption: false, // Flag for user interruption during AI speech
            lastInterruptionTime: 0,
            interruptionCooldown: 200,
            currentMessage: {},
            chatHistory: [{
                A: "Hello! You are speaking to an AI assistant."
            }],
            // AI prompt, specific to each session
            prompt: `
You are a helpful assistant. Generate your response in JSON format containing two major parts: 1) "response" (your textual reply) and 2) "output_channel" (the medium for the response). For example:
{
  "response": "Your response for the user message",
  "output_channel": "audio"
}

The "output_channel" must be one of the available channels. Currently, only "audio" is available. Always prioritize the input channel if suitable for the response.

The user's message will be a JSON object with "message" and "input_channel". For example:
{
  "message": "User's message",
  "input_channel": "audio"
}

I will provide you with the chat history and the current user message. The chat history will be structured like this:
[
  { "A": "Assistant Message" },
  { "U": "User Message" }
]
`,
            metrics: { llm: 0, stt: 0, tts: 0 },

            // Per-session child processes for audio handling
            ffmpegProcess: null,
            vadProcess: null,
            vadDeepgramBuffer: Buffer.alloc(0), // Buffer for audio chunks after VAD/FFmpeg processing
            isVadSpeechActive: false, // VAD's internal speech detection status
        };
        this.sessions.set(sessionId, session);
        console.log(`Session ${sessionId}: Created new session.`);
        return session;
    }

    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }

    deleteSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            this.cleanupSession(sessionId);
            this.sessions.delete(sessionId);
            console.log(`Session ${sessionId}: Deleted session.`);
        }
    }

    cleanupSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            if (session.dgSocket?.readyState === WebSocket.OPEN) {
                session.dgSocket.close();
                console.log(`Session ${sessionId}: Closed Deepgram socket.`);
            }
            // if (session.silenceTimer) { // Not used with current VAD/Deepgram approach
            //     clearTimeout(session.silenceTimer);
            //     session.silenceTimer = null;
            // }
            // Terminate child processes
            if (session.ffmpegProcess) {
                session.ffmpegProcess.stdin.end(); // End stdin to allow process to exit gracefully
                session.ffmpegProcess.kill('SIGINT'); // Send SIGINT to gracefully terminate
                console.log(`Session ${sessionId}: Terminated ffmpeg process.`);
            }
            if (session.vadProcess) {
                session.vadProcess.stdin.end(); // End stdin
                session.vadProcess.kill('SIGINT'); // Send SIGINT
                console.log(`Session ${sessionId}: Terminated VAD process.`);
            }
            // Ensure any ongoing audio streaming is stopped
            if (session.currentAudioStream && typeof session.currentAudioStream.stop === 'function') {
                session.currentAudioStream.stop();
            }
            session.isAIResponding = false;
        }
    }
}

// Audio Processing Utilities
const audioUtils = {
    generateSilenceBuffer: (durationMs, sampleRate = CONFIG.AUDIO_SAMPLE_RATE) => {
        // Generates a buffer of silence for mulaw 8khz, 1 channel
        const numSamples = Math.floor((durationMs / 1000) * sampleRate);
        return Buffer.alloc(numSamples); // mulaw is 8-bit, so 1 byte per sample
    },

    convertMp3ToMulaw(mp3Buffer, sessionId) {
        return new Promise((resolve, reject) => {
            const ffmpeg = spawn('ffmpeg', [
                '-i', 'pipe:0', // Input from stdin
                '-f', 'mulaw', // Output format
                '-ar', CONFIG.AUDIO_SAMPLE_RATE.toString(), // Output sample rate
                '-ac', '1', // Output channels
                '-acodec', 'pcm_mulaw', // Output codec
                '-y', // Overwrite output files without asking
                'pipe:1' // Output to stdout
            ]);

            let mulawBuffer = Buffer.alloc(0);

            ffmpeg.stdout.on('data', (data) => {
                mulawBuffer = Buffer.concat([mulawBuffer, data]);
            });

            ffmpeg.stderr.on('data', (data) => {
                // console.log(`Session ${sessionId}: FFmpeg stderr for conversion:`, data.toString());
            });

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    // console.log(`Session ${sessionId}: Audio conversion successful, buffer size:`, mulawBuffer.length);
                    resolve(mulawBuffer);
                } else {
                    console.error(`Session ${sessionId}: FFmpeg process failed with code ${code} during MP3 to Mulaw conversion.`);
                    reject(new Error(`ffmpeg process failed with code ${code}`));
                }
            });

            ffmpeg.on('error', (err) => {
                console.error(`Session ${sessionId}: FFmpeg process error during MP3 to Mulaw conversion:`, err);
                reject(err);
            });

            ffmpeg.stdin.write(mp3Buffer);
            ffmpeg.stdin.end();
        });
    },

    streamMulawAudioToTwilio: function (ws, streamSid, mulawBuffer, session) {
        const CHUNK_SIZE_MULAW = 160; // 20ms of 8khz mulaw (8000 samples/sec * 0.020 sec = 160 samples, 1 byte/sample)
        let offset = 0;
        session.isAIResponding = true;
        session.interruption = false; // Reset interruption flag when AI starts speaking

        const stopFunction = () => {
            console.log(`Session ${session.id}: Stopping outgoing audio stream...`);
            session.interruption = true; // Mark for immediate stop
            session.isAIResponding = false;
            offset = mulawBuffer.length; // Force stop by setting offset to end
            session.currentAudioStream = null; // Clear reference
        };

        session.currentAudioStream = { stop: stopFunction }; // Store stop function for external interruption

        function sendChunk() {
            if (offset >= mulawBuffer.length || session.interruption) {
                console.log(`Session ${session.id}: Audio stream ended or interrupted.`);
                session.isAIResponding = false;
                session.currentAudioStream = null;
                return;
            }

            const chunk = mulawBuffer.slice(offset, offset + CHUNK_SIZE_MULAW);
            if (chunk.length === 0) { // Handle case where the last chunk is empty
                console.log(`Session ${session.id}: Last chunk is empty, ending stream.`);
                session.isAIResponding = false;
                session.currentAudioStream = null;
                return;
            }

            try {
                ws.send(JSON.stringify({
                    event: 'media',
                    streamSid,
                    media: { payload: chunk.toString('base64') }
                }));
                offset += CHUNK_SIZE_MULAW;
                // Schedule next chunk slightly faster than chunk duration for continuous flow
                setTimeout(sendChunk, 180); // 180ms delay for 200ms chunk
            } catch (error) {
                console.error(`Session ${session.id}: Error sending audio chunk:`, error);
                stopFunction(); // Stop on error
            }
        }
        sendChunk(); // Start sending chunks
    }
};

// AI Processing
const aiProcessing = {
    async processInput(input, session) {
        try {
            session.currentMessage = input;
            session.chatHistory.push({ U: input.message });

            // Prepare messages for OpenAI
            const messages = [
                { role: "system", content: session.prompt },
                { role: "user", content: JSON.stringify({ chatHistory: session.chatHistory, currentMessage: session.currentMessage }) }
            ];

            const startTime = Date.now();
            const response = await services.openai.chat.completions.create({
                model: CONFIG.GPT_MODEL,
                messages: messages,
                temperature: CONFIG.GPT_TEMPERATURE,
                max_tokens: CONFIG.GPT_MAX_TOKENS,
                response_format: { type: "json_object" } // Request JSON object directly
            });
            const latency = Date.now() - startTime;
            session.metrics.llm = latency;

            let parsedData;
            try {
                parsedData = JSON.parse(response.choices[0].message.content);
                console.log(`Session ${session.id}: LLM Raw Response:`, response.choices[0].message.content);
                console.log(`Session ${session.id}: Parsed LLM response:`, parsedData.response);
                console.log(`Session ${session.id}: Parsed LLM output channel:`, parsedData.output_channel);
                session.chatHistory.push({ A: parsedData.response });
                return { processedText: parsedData.response, outputType: parsedData.output_channel };
            } catch (error) {
                console.error(`Session ${session.id}: Error parsing LLM JSON response:`, error);
                console.log(`Session ${session.id}: Attempting to use raw LLM content:`, response.choices[0].message.content);
                session.chatHistory.push({ A: response.choices[0].message.content });
                // Fallback if JSON parsing fails
                return {
                    processedText: response.choices[0].message.content || "Sorry, I had trouble understanding. Could you please rephrase?",
                    outputType: 'audio' // Default to audio if parsing fails
                };
            }
        } catch (error) {
            console.error(`Session ${session.id}: Error processing input with OpenAI:`, error);
            // Fallback for API errors
            return { processedText: "I'm having trouble connecting right now. Please try again later.", outputType: 'audio' };
        }
    },

    async synthesizeSpeech(text, sessionId) {
        if (!text) {
            console.error(`Session ${sessionId}: No text provided for synthesis.`);
            return null;
        }
        const startTime = Date.now();
        try {
            const command = new SynthesizeSpeechCommand({
                Text: text,
                VoiceId: CONFIG.POLLY_VOICE_ID,
                OutputFormat: CONFIG.POLLY_OUTPUT_FORMAT
            });

            const data = await services.polly.send(command);
            if (data.AudioStream) {
                const audioBuffer = Buffer.from(await data.AudioStream.transformToByteArray());
                const latency = Date.now() - startTime;
                console.log(`Session ${sessionId}: TTS Latency: ${latency}ms`);
                return audioBuffer;
            }
            throw new Error("AudioStream not found in Polly response.");
        } catch (err) {
            console.error(`Session ${sessionId}: Speech synthesis error with Polly:`, err);
            throw err;
        }
    }
};

// Initialize WebSocket Server
const wss = new WebSocket.Server({ port: 5001 });
console.log("✅ WebSocket server started on ws://localhost:5001");

// Session Management Instance
const sessionManager = new SessionManager();

// WebSocket Connection Handler
wss.on('connection', (ws) => {
    console.log("🎧 New Twilio client connected.");
    let sessionId = null; // Will be set once 'start' event is received
    let session = null; // Reference to the session object

    // Global interval to keep Deepgram connections alive for ALL active sessions
    const deepgramKeepAliveInterval = setInterval(() => {
        sessionManager.sessions.forEach(s => {
            if (s.dgSocket?.readyState === WebSocket.OPEN) {
                s.dgSocket.send(JSON.stringify({ type: "KeepAlive" }));
            }
        });
    }, 10000); // Send keep-alive every 10 seconds

    // Function to establish Deepgram connection for a specific session
    const connectToDeepgram = (currentSession) => {
        if (!currentSession || !currentSession.id) {
            console.error('Attempted to connect to Deepgram without a valid session.');
            return;
        }

        if (currentSession.dgSocket && currentSession.dgSocket.readyState === WebSocket.OPEN) {
            currentSession.dgSocket.close(); // Close existing socket if open
        }

        currentSession.dgSocket = new WebSocket(
            `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=${CONFIG.SAMPLE_RATE}&channels=1&model=nova-3&language=en&punctuate=true&interim_results=true&endpointing=100`,
            {
                headers: {
                    'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`
                }
            }
        );

        currentSession.dgSocket.on('open', () => {
            console.log(`Session ${currentSession.id}: ✅ Deepgram connected.`);
            currentSession.reconnectAttempts = 0;
        });

        currentSession.dgSocket.on('message', async (data) => {
            try {
                const received = JSON.parse(data);

                // Update global performance metrics based on Deepgram final results
                if (received.is_final && currentSession.audioStartTime) {
                    performance.updateStats(Date.now() - currentSession.audioStartTime);
                    currentSession.audioStartTime = null; // Reset for next utterance
                }

                if (received.channel?.alternatives?.[0]?.transcript) {
                    const transcript = received.channel.alternatives[0].transcript;
                    // const confidence = received.channel?.alternatives?.[0]?.confidence || 0; // Not used for interim filtering
                    const now = Date.now();

                    if (received.is_final) {
                        // Handle final transcript
                        currentSession.isSpeaking = false; // User has finished speaking (Deepgram final)
                        currentSession.lastInterimTranscript = ''; // Clear interim for next turn
                        currentSession.interimResultsBuffer = []; // Clear buffer

                        // If you had a silence timer, clear it here (not used in this version)
                        // if (currentSession.silenceTimer) {
                        //     clearTimeout(currentSession.silenceTimer);
                        //     currentSession.silenceTimer = null;
                        // }

                        if (transcript.trim().length > 0 && transcript !== currentSession.lastTranscript) {
                            currentSession.transcriptBuffer.push(transcript);
                            currentSession.lastTranscript = transcript;
                        }

                        if (currentSession.transcriptBuffer.length > 0) {
                            const finalTranscript = currentSession.transcriptBuffer.join(' ').trim();
                            currentSession.userSpeak = true;
                            console.log(`Session ${currentSession.id}: Final Transcript: "${finalTranscript}"`);

                            // Send final transcript back to the Twilio stream (e.g., for display/debugging)
                            ws.send(JSON.stringify({
                                type: 'final_transcript',
                                transcript: finalTranscript,
                                isFinal: true
                            }));

                            try {
                                const { processedText, outputType } = await aiProcessing.processInput(
                                    { message: finalTranscript, input_channel: 'audio' },
                                    currentSession
                                );

                                if (outputType === 'audio') {
                                    currentSession.isAIResponding = true;
                                    const audioBuffer = await aiProcessing.synthesizeSpeech(processedText, currentSession.id);
                                    if (!audioBuffer) {
                                        console.error(`Session ${currentSession.id}: Failed to synthesize speech.`);
                                        currentSession.isAIResponding = false;
                                        return;
                                    }
                                    const mulawBuffer = await audioUtils.convertMp3ToMulaw(audioBuffer, currentSession.id);
                                    if (mulawBuffer) {
                                        audioUtils.streamMulawAudioToTwilio(ws, currentSession.streamSid, mulawBuffer, currentSession);
                                    } else {
                                        console.error(`Session ${currentSession.id}: Failed to convert audio to mulaw.`);
                                        currentSession.isAIResponding = false;
                                    }
                                } else {
                                    // Handle text output if your Twilio integration can display it
                                    ws.send(JSON.stringify({
                                        type: 'ai_response_text',
                                        text: processedText,
                                        isFinal: true,
                                        latency: currentSession.metrics
                                    }));
                                    currentSession.isAIResponding = false;
                                }
                            } catch (err) {
                                console.error(`Session ${currentSession.id}: AI Processing or TTS error:`, err);
                                ws.send(JSON.stringify({
                                    type: 'error',
                                    error: 'Failed to process AI response or synthesize speech.'
                                }));
                                currentSession.isAIResponding = false;
                            }
                            currentSession.transcriptBuffer = []; // Clear buffer after processing
                        }
                    } else { // It's an interim result
                        // Send interim transcript immediately to Twilio client if new and not empty
                        if (transcript.trim().length > 0 && transcript !== currentSession.lastInterimTranscript) {
                            currentSession.isSpeaking = true; // User is speaking
                            currentSession.lastInterimTime = now;
                            currentSession.lastInterimTranscript = transcript;

                            ws.send(JSON.stringify({
                                type: 'interim_transcript',
                                transcript: transcript,
                                isInterim: true
                            }));
                        }
                    }
                }
            } catch (err) {
                console.error(`Session ${currentSession.id}: Deepgram message parse error:`, err);
            }
        });

        currentSession.dgSocket.on('error', (err) => {
            console.error(`Session ${currentSession.id}: Deepgram error:`, err);
            handleDeepgramReconnect(currentSession);
        });

        currentSession.dgSocket.on('close', () => {
            console.log(`Session ${currentSession.id}: Deepgram connection closed.`);
            handleDeepgramReconnect(currentSession);
        });
    };

    // Function to handle Deepgram reconnection for a specific session
    const handleDeepgramReconnect = (currentSession) => {
        if (!currentSession || !currentSession.id) return; // Defensive check

        if (currentSession.reconnectAttempts < CONFIG.MAX_RECONNECT_ATTEMPTS) {
            currentSession.reconnectAttempts++;
            console.log(`Session ${currentSession.id}: Reconnecting to Deepgram (${currentSession.reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS})...`);
            setTimeout(() => connectToDeepgram(currentSession), CONFIG.RECONNECT_DELAY);
        } else {
            console.error(`Session ${currentSession.id}: Max Deepgram reconnection attempts reached. Terminating session.`);
            ws.send(JSON.stringify({ error: 'Failed to connect to transcription service. Ending call.' }));
            ws.close(); // Close the Twilio WebSocket, prompting Twilio to hang up
        }
    };

    // Function to handle interruption of AI speech
    const handleInterruption = (currentSession) => {
        if (!currentSession || !currentSession.isAIResponding) return;

        console.log(`Session ${currentSession.id}: Handling interruption.`);

        // Stop any ongoing audio stream for this session
        if (currentSession.currentAudioStream && typeof currentSession.currentAudioStream.stop === 'function') {
            try {
                currentSession.currentAudioStream.stop();
            } catch (error) {
                console.error(`Session ${currentSession.id}: Error stopping current audio stream:`, error);
            }
            currentSession.currentAudioStream = null;
        }

        // Send a few small silence buffers to Twilio to quickly "cut off" any remaining audio
        // This is a common trick to ensure prompt interruption.
        for (let i = 0; i < 3; i++) {
            const silenceBuffer = audioUtils.generateSilenceBuffer(10); // 10ms silence
            try {
                ws.send(JSON.stringify({
                    event: 'media',
                    streamSid: currentSession.streamSid,
                    media: { payload: silenceBuffer.toString('base64') }
                }));
            } catch (error) {
                console.error(`Session ${currentSession.id}: Error sending silence buffer during interruption:`, error);
            }
        }

        currentSession.isAIResponding = false;
        currentSession.interruption = true; // Set flag to prevent new audio from starting immediately

        // Reset interruption flag after a short cooldown
        setTimeout(() => {
            currentSession.interruption = false;
            console.log(`Session ${currentSession.id}: Interruption cooldown finished.`);
        }, currentSession.interruptionCooldown);
    };

    // Main message handler for the Twilio WebSocket connection
    ws.on('message', async (data) => {
        try {
            const parsedData = JSON.parse(data);

            if (parsedData.event === 'start') {
                sessionId = parsedData.streamSid;
                session = sessionManager.createSession(sessionId, ws); // Pass ws to session manager
                session.callSid = parsedData.start.callSid;
                session.streamSid = parsedData.streamSid; // Confirm streamSid in session

                console.log(`Session ${sessionId}: Twilio stream started for CallSid: ${session.callSid}`);

                // Initialize per-session FFmpeg and VAD processes
                session.ffmpegProcess = spawn('ffmpeg', [
                    '-loglevel', 'quiet',
                    '-f', 'mulaw', // Input format from Twilio
                    '-ar', CONFIG.AUDIO_SAMPLE_RATE.toString(), // Input sample rate from Twilio
                    '-ac', '1', // Input channels
                    '-i', 'pipe:0', // Input from stdin
                    '-f', 's16le', // Output format for VAD/Deepgram
                    '-acodec', 'pcm_s16le', // Output codec
                    '-ar', CONFIG.SAMPLE_RATE.toString(), // Output sample rate for VAD/Deepgram
                    '-ac', '1', // Output channels
                    'pipe:1' // Output to stdout
                ]);

                session.vadProcess = spawn(process.env.PYTHON_PATH || 'python3', ['vad.py']); // Use env var for Python path
                session.ffmpegProcess.stdout.pipe(session.vadProcess.stdin); // Pipe FFmpeg output to VAD input

                // Attach VAD listener specific to this session
                session.vadProcess.stdout.on('data', (vadData) => {
                    try {
                        const parsedVAD = JSON.parse(vadData.toString());

                        if (parsedVAD.event === 'speech_start') {
                            session.isVadSpeechActive = true;
                            console.log(`Session ${session.id}: VAD detected Speech START. Resetting Deepgram buffer.`);
                            session.vadDeepgramBuffer = Buffer.alloc(0); // Clear any old buffered audio
                            if (session.isAIResponding && (Date.now() - session.lastInterruptionTime > session.interruptionCooldown)) {
                                console.log(`Session ${session.id}: VAD detected speech during AI response. Initiating interruption.`);
                                handleInterruption(session);
                                session.lastInterruptionTime = Date.now();
                            }
                        } else if (parsedVAD.event === 'speech_end') {
                            session.isVadSpeechActive = false;
                            console.log(`Session ${session.id}: VAD detected Speech END.`);
                            // When speech ends, send any remaining buffered audio to Deepgram
                            if (session.vadDeepgramBuffer.length > 0 && session.dgSocket?.readyState === WebSocket.OPEN) {
                                session.dgSocket.send(session.vadDeepgramBuffer);
                                session.vadDeepgramBuffer = Buffer.alloc(0); // Clear buffer after sending
                            }
                            // Important: Send Deepgram a "Finalize" message when VAD detects speech end
                            if (session.dgSocket?.readyState === WebSocket.OPEN) {
                                console.log(`Session ${session.id}: Sending Deepgram Finalize message.`);
                                session.dgSocket.send(JSON.stringify({ "type": "Finalize" }));
                            }
                        }

                        if (parsedVAD.chunk) {
                            const audioBuffer = Buffer.from(parsedVAD.chunk, 'hex');
                            session.vadDeepgramBuffer = Buffer.concat([session.vadDeepgramBuffer, audioBuffer]);

                            // Send to Deepgram immediately if speech is active and Deepgram is open,
                            // OR if the buffer reaches a small threshold.
                            // The key is to send frequently, not wait for a large chunk.
                            if (session.isVadSpeechActive && session.dgSocket?.readyState === WebSocket.OPEN) {
                                while (session.vadDeepgramBuffer.length >= CONFIG.DEEPGRAM_STREAM_CHUNK_SIZE) {
                                    const chunkToSend = session.vadDeepgramBuffer.slice(0, CONFIG.DEEPGRAM_STREAM_CHUNK_SIZE);
                                    session.dgSocket.send(chunkToSend);
                                    session.vadDeepgramBuffer = session.vadDeepgramBuffer.slice(CONFIG.DEEPGRAM_STREAM_CHUNK_SIZE);
                                    session.audioStartTime = Date.now(); // Mark time when audio is sent
                                }
                            }
                        }
                    } catch (err) {
                        console.error(`Session ${session.id}: VAD output parse error:`, err);
                    }
                });

                // Handle errors from FFmpeg and VAD processes for this session
                session.ffmpegProcess.stderr.on('data', (data) => {
                    // console.error(`Session ${sessionId}: FFmpeg stderr: ${data.toString()}`);
                });
                session.ffmpegProcess.on('error', (err) => {
                    console.error(`Session ${sessionId}: FFmpeg process error:`, err);
                });
                session.ffmpegProcess.on('close', (code) => {
                    if (code !== 0) console.warn(`Session ${sessionId}: FFmpeg process exited with code ${code}.`);
                });

                session.vadProcess.stderr.on('data', (data) => {
                    // console.error(`Session ${sessionId}: VAD stderr: ${data.toString()}`);
                });
                session.vadProcess.on('error', (err) => {
                    console.error(`Session ${sessionId}: VAD process error:`, err);
                });
                session.vadProcess.on('close', (code) => {
                    if (code !== 0) console.warn(`Session ${sessionId}: VAD process exited with code ${code}.`);
                });

                // Connect to Deepgram after processes are set up
                connectToDeepgram(session);

                // Send initial announcement
                const announcementText = session.chatHistory[0].A; // Get initial message from chat history
                const mp3Buffer = await aiProcessing.synthesizeSpeech(announcementText, session.id);
                if (mp3Buffer) {
                    const mulawBuffer = await audioUtils.convertMp3ToMulaw(mp3Buffer, session.id);
                    if (mulawBuffer) {
                        audioUtils.streamMulawAudioToTwilio(ws, session.streamSid, mulawBuffer, session);
                    }
                }

            } else if (parsedData.event === 'media' && parsedData.media?.payload) {
                // Ensure session exists and ffmpeg is ready to receive audio
                if (session && session.ffmpegProcess && session.ffmpegProcess.stdin.writable) {
                    const audioBuffer = Buffer.from(parsedData.media.payload, 'base64');
                    session.ffmpegProcess.stdin.write(audioBuffer); // Write to this session's ffmpeg
                } else {
                    // console.warn(`Session ${sessionId}: Media received but ffmpeg not ready or session not found.`);
                }
            } else if (parsedData.type === 'chat') {
                // This block handles chat messages (if your client sends them over the same WS)
                if (!session) {
                    console.error('No session ID available for chat message. Ignoring.');
                    return;
                }
                const { processedText, outputType } = await aiProcessing.processInput(parsedData.message, session);

                if (outputType === 'text') {
                    ws.send(JSON.stringify({
                        type: 'text_response',
                        text: processedText,
                        isFinal: true,
                        latency: session.metrics
                    }));
                } else if (outputType === 'audio') {
                    const audioBuffer = await aiProcessing.synthesizeSpeech(processedText, session.id);
                    if (audioBuffer) {
                        const mulawBuffer = await audioUtils.convertMp3ToMulaw(audioBuffer, session.id);
                        if (mulawBuffer) {
                            audioUtils.streamMulawAudioToTwilio(ws, session.streamSid, mulawBuffer, session);
                        }
                    }
                }
            }
            // Add other event types if necessary (e.g., 'stop', 'mark')
        } catch (err) {
            console.error(`Session ${sessionId}: Error processing Twilio WebSocket message:`, err);
        }
    });

    ws.on('close', () => {
        console.log(`Session ${sessionId}: Twilio client disconnected.`);
        if (sessionId) {
            sessionManager.deleteSession(sessionId);
        }
        clearInterval(deepgramKeepAliveInterval); // Clear keep-alive for this WS
    });

    ws.on('error', (error) => {
        console.error(`Session ${sessionId}: Twilio client error:`, error);
        if (sessionId) {
            sessionManager.cleanupSession(sessionId); // Cleanup on error
        }
        clearInterval(deepgramKeepAliveInterval); // Clear keep-alive for this WS
    });
});

// Process Termination Handler for the main server process
process.on('SIGINT', () => {
    console.log('\nServer shutting down. Cleaning up all sessions...');
    sessionManager.sessions.forEach((s, sessionId) => {
        sessionManager.cleanupSession(sessionId);
    });
    // Give a small moment for processes to terminate
    setTimeout(() => {
        wss.close(() => {
            console.log('WebSocket server closed.');
            process.exit(0);
        });
    }, 500);
});