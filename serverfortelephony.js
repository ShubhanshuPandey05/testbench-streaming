// Core Dependencies
const { spawn } = require('child_process');
const WebSocket = require('ws');
require('dotenv').config();
const { createClient } = require('@deepgram/sdk');
const { PollyClient, SynthesizeSpeechCommand } = require("@aws-sdk/client-polly");
const OpenAI = require("openai");
const twilio = require('twilio');
const fs = require('fs');

// Configuration Constants
const CONFIG = {
  MAX_RECONNECT_ATTEMPTS: 5,
  RECONNECT_DELAY: 1000,
  SILENCE_THRESHOLD: 500,
  INTERIM_CONFIDENCE_THRESHOLD: 0.7,
  INTERIM_TIME_THRESHOLD: 10,
  CHUNK_SIZE: 6400,
  AUDIO_CHUNK_SIZE: 1600,
  SAMPLE_RATE: 16000,
  AUDIO_SAMPLE_RATE: 8000,
  POLLY_VOICE_ID: "Joanna",
  POLLY_OUTPUT_FORMAT: "mp3",
  GPT_MODEL: "gpt-4o-mini",
  GPT_MAX_TOKENS: 100,
  GPT_TEMPERATURE: 0.1
};

// Service Initialization
const services = {
  twilio: new twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN),
  polly: new PollyClient({
    region: "us-east-1",
    credentials: {
      accessKeyId: process.env.accessKeyId,
      secretAccessKey: process.env.secretAccessKey,
    },
  }),
  openai: new OpenAI({ apiKey: process.env.OPEN_AI })
};

// Performance Monitoring
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
      console.log('\n=== Performance Metrics ===');
      console.log(`Average Latency: ${avg.toFixed(2)}ms`);
      console.log(`Min Latency: ${this.latency.min.toFixed(2)}ms`);
      console.log(`Max Latency: ${this.latency.max.toFixed(2)}ms`);
      console.log(`Total Samples: ${this.latency.count}`);
      console.log('==========================\n');

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
    this.sessions = new Map();
  }

  createSession(sessionId) {
    const session = {
      id: sessionId,
      dgSocket: null,
      reconnectAttempts: 0,
      lastTranscript: '',
      transcriptBuffer: [],
      silenceTimer: null,
      audioStartTime: null,
      lastInterimTime: Date.now(),
      isSpeaking: false,
      lastInterimTranscript: '',
      interimResultsBuffer: [],
      userSpeak: false,
      streamSid: '',
      callSid: '',
      message: [{
        role: "system",
        content: `You are a helpful assistant. Always reply in JSON with two keys: 'output' (the answer) and 'outputType' (either 'text' or 'audio'). The prompt will be in the format of "{message:user_query, type:input_channel}". Choose outputType based on: 1) Usually match input channel unless user specifies otherwise or content is unsuitable, 2) Use 'text' for emails, code, etc.`
      }],
      metrics: { llm: 0, stt: 0, tts: 0 }
    };
    this.sessions.set(sessionId, session);
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
    }
  }

  cleanupSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.dgSocket?.readyState === WebSocket.OPEN) {
        session.dgSocket.close();
      }
      if (session.silenceTimer) {
        clearTimeout(session.silenceTimer);
      }
    }
  }
}

// Audio Processing Utilities
const audioUtils = {
  generateSilenceBuffer: (durationMs, sampleRate = CONFIG.SAMPLE_RATE) => {
    const numSamples = Math.floor((durationMs / 1000) * sampleRate);
    return Buffer.alloc(numSamples * 2);
  },

  convertMp3ToMulaw(mp3Buffer) {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-i', 'pipe:0',         // Input from stdin
        '-f', 'mulaw',          // Output format: mulaw
        '-ar', '8000',          // Output sample rate: 8kHz
        '-ac', '1',             // Mono
        'pipe:1'                // Output to stdout
      ]);

      let mulawBuffer = Buffer.alloc(0);

      ffmpeg.stdout.on('data', (data) => {
        mulawBuffer = Buffer.concat([mulawBuffer, data]);
      });

      ffmpeg.stderr.on('data', (data) => {
        // Optional: log ffmpeg errors
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve(mulawBuffer);
        } else {
          reject(new Error('ffmpeg process failed'));
        }
      });

      ffmpeg.stdin.write(mp3Buffer);
      ffmpeg.stdin.end();
    });
  },


  streamMulawAudioToTwilio(ws, streamSid, mulawBuffer) {
    const CHUNK_SIZE = 1600; // 20ms for 8kHz mulaw
    let offset = 0;

    // console.log(streamSid)
    function sendChunk() {
      if (offset >= mulawBuffer.length) {
        return;
      }

      const chunk = mulawBuffer.slice(offset, offset + CHUNK_SIZE);
      // console.log(`Sending chunk at offset: ${offset}`); // log this
      ws.send(JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: chunk.toString('base64') }
      }));
      offset += CHUNK_SIZE;
      setTimeout(sendChunk, 200);
    }

    sendChunk();
  }
};

// AI Processing
const aiProcessing = {
  async processInput(input, session) {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPEN_AI}`
        },
        body: JSON.stringify({
          model: CONFIG.GPT_MODEL,
          messages: [...session.message, { role: "user", content: input }],
          max_tokens: CONFIG.GPT_MAX_TOKENS,
          temperature: CONFIG.GPT_TEMPERATURE
        })
      });

      const data = await response.json();
      const latency = Date.now() - session.audioStartTime;
      session.metrics.llm = latency;

      try {
        const parsedData = JSON.parse(data.choices[0].message.content);
        session.message.push({
          role: "assistant",
          content: parsedData.output
        });
        console.log("Parsed data of LLM response : ", parsedData.output);
        return { processedText: parsedData.output, outputType: parsedData.outputType };
      } catch (error) {
        console.error('Error parsing LLM response:', error);
        console.log("LLM response :", data.choices[0].message.content)
        return {
          processedText: data.choices[0].message.content || input,
          outputType: 'audio'
        };
      }
    } catch (error) {
      console.error('Error processing input:', error);
      return { processedText: input, outputType: 'text' };
    }
  },

  async synthesizeSpeech(text) {
    if (!text) {
      console.error('No text provided for synthesis');
      return null;
    }

    try {
      const command = new SynthesizeSpeechCommand({
        Text: text,
        VoiceId: CONFIG.POLLY_VOICE_ID,
        OutputFormat: CONFIG.POLLY_OUTPUT_FORMAT
      });

      const data = await services.polly.send(command);
      if (data.AudioStream) {
        return Buffer.from(await data.AudioStream.transformToByteArray());
      }
      throw new Error("AudioStream not found in response");
    } catch (err) {
      console.error("Speech synthesis error:", err);
      throw err;
    }
  }
};

// Initialize WebSocket Server
const wss = new WebSocket.Server({ port: 5001 });
console.log("✅ WebSocket server started on ws://localhost:5001");

// Initialize Audio Processing
const pythonPath = 'C:/Users/shubh/miniconda3/envs/vad-env/python.exe';
const vad = spawn(pythonPath, ['vad.py']);
const ffmpeg = spawn('ffmpeg', [
  '-loglevel', 'quiet',
  '-f', 'mulaw',
  '-ar', CONFIG.AUDIO_SAMPLE_RATE.toString(),
  '-ac', '1',
  '-i', 'pipe:0',
  '-f', 's16le',
  '-acodec', 'pcm_s16le',
  '-ar', CONFIG.SAMPLE_RATE.toString(),
  'pipe:1'
]);

ffmpeg.stdout.pipe(vad.stdin);

// Session Management Instance
const sessionManager = new SessionManager();

// WebSocket Connection Handler
wss.on('connection', (ws) => {
  console.log("🎧 Client connected");
  let sessionId = null;
  let session = null;
  let interruption = false;
  let deepgramBuffer = Buffer.alloc(0);
  let isSpeechActive = false;
  let currentAudioStream = null;
  let isAIResponding = false;

  const connectToDeepgram = () => {
    if (!sessionId) return; // Don't connect until we have a streamSid

    if (session.dgSocket) {
      session.dgSocket.close();
    }

    session.dgSocket = new WebSocket(
      `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=${CONFIG.SAMPLE_RATE}&channels=1&model=nova-3&language=en&punctuate=true&interim_results=true&endpointing=100`,
      ['token', process.env.DEEPGRAM_API]
    );

    session.dgSocket.on('open', () => {
      console.log(`✅ Deepgram connected for session ${sessionId}`);
      session.reconnectAttempts = 0;
    });

    session.dgSocket.on('message', async (data) => {
      try {
        const received = JSON.parse(data);
        if (received.channel?.alternatives?.[0]?.transcript) {
          const transcript = received.channel.alternatives[0].transcript;
          const confidence = received.channel?.alternatives?.[0]?.confidence || 0;
          const now = Date.now();

          if (session.audioStartTime) {
            performance.updateStats(now - session.audioStartTime);
          }

          if (!received.is_final) {
            if (confidence >= CONFIG.INTERIM_CONFIDENCE_THRESHOLD &&
              (now - session.lastInterimTime >= CONFIG.INTERIM_TIME_THRESHOLD) &&
              (session.isSpeaking || transcript.length > 2) &&
              transcript !== session.lastInterimTranscript) {

              session.isSpeaking = true;
              session.lastInterimTime = now;
              session.lastInterimTranscript = transcript;
              session.interimResultsBuffer.push(transcript);

              // Only interrupt if there's significant speech
              if (isAIResponding && transcript.length > 10) {
                handleInterruption(session);
              }

              ws.send(JSON.stringify({
                transcript,
                isInterim: true
              }));
            }
            return;
          }

          if (received.is_final) {
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
              session.userSpeak = true;
              ws.send(JSON.stringify({
                transcript: finalTranscript,
                isFinal: true
              }));

              try {
                console.log("Final transcript : ", finalTranscript)
                const { processedText, outputType } = await aiProcessing.processInput(
                  `{message:${finalTranscript}, type:'audio'}`,
                  session
                );

                if (outputType === 'audio') {
                  isAIResponding = true;
                  const audioBuffer = await aiProcessing.synthesizeSpeech(processedText);
                  if (!audioBuffer) {
                    console.error('Failed to synthesize speech');
                    return;
                  }
                  console.log('Audio synthesized, converting to mulaw...');
                  const mulawBuffer = await audioUtils.convertMp3ToMulaw(audioBuffer);
                  if (mulawBuffer) {
                    // console.log('Starting audio response, buffer size:', mulawBuffer.length);
                    // Send a marker before starting audio
                    // ws.send(JSON.stringify({
                    //   event: 'mark',
                    //   streamSid: session.streamSid,
                    //   mark: { name: 'start_audio' }
                    // }));
                    audioUtils.streamMulawAudioToTwilio(ws, session.streamSid, mulawBuffer);

                    // console.log("Audio", mulawBuffer)
                    // ws.send(JSON.stringify({
                    //   event: 'media',
                    //   streamSid: session.streamSid,
                    //   media: { payload: mulawBuffer.toString('base64') }
                    // }));
                  } else {
                    console.error('Failed to convert audio to mulaw');
                  }
                } else {
                  ws.send(JSON.stringify({
                    type: 'text',
                    text: processedText,
                    isFinal: true,
                    latency: session.metrics
                  }));
                }
              } catch (err) {
                console.error('Processing error:', err);
                ws.send(JSON.stringify({
                  type: 'tts_error',
                  error: 'Failed to process or synthesize speech'
                }));
              }
              session.transcriptBuffer = [];
            }
          }
        }
      } catch (err) {
        console.error('Deepgram parse error:', err);
      }
    });

    session.dgSocket.on('error', (err) => {
      console.error(`Deepgram error for session ${sessionId}:`, err);
      handleReconnect();
    });

    session.dgSocket.on('close', () => {
      console.log(`Deepgram closed for session ${sessionId}`);
      handleReconnect();
    });
  };

  const handleReconnect = () => {
    if (session.reconnectAttempts < CONFIG.MAX_RECONNECT_ATTEMPTS) {
      session.reconnectAttempts++;
      console.log(`Reconnecting to Deepgram (${session.reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS})...`);
      setTimeout(connectToDeepgram, CONFIG.RECONNECT_DELAY);
    } else {
      console.error('Max reconnection attempts reached');
      ws.send(JSON.stringify({ error: 'Failed to connect to transcription service' }));
    }
  };

  const handleInterruption = async (session) => {
    if (isAIResponding && currentAudioStream) {
      console.log('Interruption detected - stopping current response');
      currentAudioStream.stop();
      currentAudioStream = null;
      isAIResponding = false;

      // Send a brief silence to ensure clean interruption
      const silenceBuffer = audioUtils.generateSilenceBuffer(100);
      ws.send(JSON.stringify({
        event: 'media',
        streamSid: session.streamSid,
        media: { payload: silenceBuffer.toString('base64') }
      }));
    }
  };

  connectToDeepgram();

  setInterval(() => {
    if (!isSpeechActive) {
      session.dgSocket.send(JSON.stringify({ type: "KeepAlive" }));
    }
  }, 10000);

  vad.stdout.on('data', (data) => {
    try {
      const parsed = JSON.parse(data.toString());

      if (parsed.event === 'speech_start') {
        isSpeechActive = true;
        interruption = true;
        handleInterruption(session);
      } else if (parsed.event === 'speech_end') {
        isSpeechActive = false;
        interruption = false;
        if (!isSpeechActive && session.dgSocket?.readyState === WebSocket.OPEN) {
          session.dgSocket.send(JSON.stringify({ type: "Finalize" }));
        }
      }

      if (parsed.chunk) {
        const audioBuffer = Buffer.from(parsed.chunk, 'hex');
        deepgramBuffer = Buffer.concat([deepgramBuffer, audioBuffer]);

        if (deepgramBuffer.length >= CONFIG.CHUNK_SIZE && session.dgSocket?.readyState === WebSocket.OPEN) {
          session.audioStartTime = Date.now();
          session.dgSocket.send(deepgramBuffer);
          deepgramBuffer = Buffer.alloc(0);
        }
      }
    } catch (err) {
      console.error('VAD parse error:', err);
    }
  });

  ws.on('message', async (data) => {
    try {
      const parsedData = JSON.parse(data);

      if (parsedData.type === 'chat') {
        if (!sessionId) {
          console.error('No session ID available for chat message');
          return;
        }
        const { processedText, outputType } = await aiProcessing.processInput(parsedData.message, session);

        if (outputType === 'text') {
          ws.send(JSON.stringify({
            type: 'text',
            text: processedText,
            isFinal: true,
            latency: session.metrics
          }));
        } else if (outputType === 'audio') {
          const audioBuffer = await aiProcessing.synthesizeSpeech(processedText);
          if (audioBuffer) {
            ws.send(JSON.stringify({
              type: 'audio',
              audio: audioBuffer.toString('base64'),
              isFinal: true,
              latency: session.metrics
            }));
          }
        }
      }

      if (parsedData.event === 'media' && parsedData.media?.payload) {
        const audioBuffer = Buffer.from(parsedData.media.payload, 'base64');
        if (ffmpeg.stdin.writable) {
          ffmpeg.stdin.write(audioBuffer);
        }
      }

      if (parsedData.event === 'start') {
        sessionId = parsedData.streamSid;
        session = sessionManager.createSession(sessionId);
        session.callSid = parsedData.start.callSid;
        session.streamSid = parsedData.streamSid;

        // Connect to Deepgram after we have the session ID
        connectToDeepgram();

        const announcementText = "Hello! You are speaking to an AI assistant.";
        const mp3Buffer = await aiProcessing.synthesizeSpeech(announcementText);
        const mulawBuffer = await audioUtils.convertMp3ToMulaw(mp3Buffer);
        if (mulawBuffer) {
          audioUtils.streamMulawAudioToTwilio(ws, session.streamSid, mulawBuffer);
        }
      }
    } catch (err) {
      console.error('Message processing error:', err);
    }
  });

  ws.on('close', () => {
    if (sessionId) {
      console.log(`Client disconnected for session ${sessionId}`);
      sessionManager.deleteSession(sessionId);
    }
  });

  ws.on('error', (error) => {
    if (sessionId) {
      console.error(`Client error for session ${sessionId}:`, error);
      sessionManager.cleanupSession(sessionId);
    }
  });
});

// Process Termination Handler
process.on('SIGINT', () => {
  if (ffmpeg.stdin.writable) ffmpeg.stdin.end();
  process.exit();
});