const { spawn } = require('child_process');
const WebSocket = require('ws');
require('dotenv').config();
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { PollyClient, SynthesizeSpeechCommand } = require("@aws-sdk/client-polly");
const OpenAI = require("openai");

const wss = new WebSocket.Server({ port: 5001 });
console.log("✅ WebSocket server started on ws://localhost:5001");

const polly = new PollyClient({
  region: "us-east-1",
  credentials: {
    accessKeyId: `${process.env.accessKeyId}`,
    secretAccessKey: `${process.env.secretAccessKey}`,
  },
});

const client = new OpenAI({ apiKey: process.env.OPEN_AI });

// Latency tracking
const latencyStats = {
  totalLatency: 0,
  count: 0,
  minLatency: Infinity,
  maxLatency: 0,
  lastUpdate: Date.now()
};

const latency = {
  llm: 0,
  stt: 0,
  tts: 0,
};

const updateLatencyStats = (latency) => {
  latencyStats.totalLatency += latency;
  latencyStats.count++;
  latencyStats.minLatency = Math.min(latencyStats.minLatency, latency);
  latencyStats.maxLatency = Math.max(latencyStats.maxLatency, latency);

  // Log stats every 5 seconds
  const now = Date.now();
  if (now - latencyStats.lastUpdate >= 5000) {
    const avgLatency = latencyStats.totalLatency / latencyStats.count;
    console.log('\n=== Latency Statistics ===');
    console.log(`Average Latency: ${avgLatency.toFixed(2)}ms`);
    console.log(`Min Latency: ${latencyStats.minLatency.toFixed(2)}ms`);
    console.log(`Max Latency: ${latencyStats.maxLatency.toFixed(2)}ms`);
    console.log(`Total Samples: ${latencyStats.count}`);
    console.log('==========================\n');

    // Reset stats
    latencyStats.totalLatency = 0;
    latencyStats.count = 0;
    latencyStats.minLatency = Infinity;
    latencyStats.maxLatency = 0;
    latencyStats.lastUpdate = now;
  }
};

const pythonPath = 'C:/Users/shubh/miniconda3/envs/vad-env/python.exe';

// Launch Python VAD script
const vad = spawn(pythonPath, ['vad.py']);

// Spawn FFmpeg to decode audio to PCM with optimized settings
const ffmpeg = spawn('ffmpeg', [
  '-loglevel', 'quiet',
  '-i', 'pipe:0',        // input from stdin
  '-f', 's16le',         // raw PCM output
  '-acodec', 'pcm_s16le',
  '-ac', '1',            // mono
  '-ar', '16000',        // 16kHz
  '-threads', '0',       // use all available threads
  '-af', 'highpass=f=200,lowpass=f=3000', // basic noise filtering
  'pipe:1'               // output to stdout
]);

const deepgram = createClient(process.env.DEEPGRAM_API);

// Pipe FFmpeg output to Python VAD input
ffmpeg.stdout.pipe(vad.stdin);

// Log errors
ffmpeg.stderr.on('data', (data) => console.error(`FFmpeg error: ${data}`));
vad.stderr.on('data', (data) => console.error(`VAD error: ${data}`));

// Handle process errors
ffmpeg.on('error', (err) => console.error('FFmpeg process error:', err));
vad.on('error', (err) => console.error('VAD process error:', err));

// Handle process exit
ffmpeg.on('exit', (code) => console.log(`FFmpeg process exited with code ${code}`));
vad.on('exit', (code) => console.log(`VAD process exited with code ${code}`));

wss.on('connection', (ws) => {
  console.log("🎧 Client connected");
  let dgSocket = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 5;
  const RECONNECT_DELAY = 1000; // 1 second
  let lastTranscript = '';
  let transcriptBuffer = [];
  let silenceTimer = null;
  const SILENCE_THRESHOLD = 500; // 500ms of silence
  let audioStartTime = null;
  let lastInterimTime = Date.now();
  let isSpeaking = false;
  const INTERIM_CONFIDENCE_THRESHOLD = 0.7;
  const INTERIM_TIME_THRESHOLD = 10;
  let lastInterimTranscript = '';
  let interimResultsBuffer = [];

  const connectToDeepgram = () => {
    if (dgSocket) {
      dgSocket.close();
    }

    dgSocket = new WebSocket(
      `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&model=nova-3&language=en&punctuate=true&interim_results=true&endpointing=100`,
      ['token', `${process.env.DEEPGRAM_API}`]
    );

    dgSocket.on('open', () => {
      console.log("✅ Deepgram WebSocket connected");
      reconnectAttempts = 0;
    });

    dgSocket.on('message', async (data) => {
      try {
        const received = JSON.parse(data);
        if (received.channel?.alternatives?.[0]?.transcript) {
          const transcript = received.channel.alternatives[0].transcript;
          const confidence = received.channel?.alternatives?.[0]?.confidence || 0;
          const now = Date.now();

          // Calculate latency
          if (audioStartTime) {
            const latency = now - audioStartTime;
            updateLatencyStats(latency);
          }

          // Handle interim results
          if (!received.is_final) {
            if (confidence >= INTERIM_CONFIDENCE_THRESHOLD &&
              (now - lastInterimTime >= INTERIM_TIME_THRESHOLD) &&
              (isSpeaking || transcript.length > 2) &&
              transcript !== lastInterimTranscript) {

              isSpeaking = true;
              lastInterimTime = now;
              lastInterimTranscript = transcript;

              // Add to interim buffer
              interimResultsBuffer.push(transcript);

              // Send the latest interim result
              ws.send(JSON.stringify({
                transcript: transcript,
                isInterim: true
              }));
            }
            return;
          }

          // Handle final results
          if (received.is_final) {
            isSpeaking = false;
            lastInterimTranscript = '';
            interimResultsBuffer = [];

            if (silenceTimer) {
              clearTimeout(silenceTimer);
              silenceTimer = null;
            }

            if (transcript !== lastTranscript) {
              transcriptBuffer.push(transcript);
              lastTranscript = transcript;
            }

            if (transcriptBuffer.length > 0) {
              const finalTranscript = transcriptBuffer.join(' ');
              console.log('Final transcript before LLM:', finalTranscript);

              ws.send(JSON.stringify({
                transcript: finalTranscript,
                isFinal: true
              }));










              // Process final transcript through LLM and then TTS
              try {
                const processedText = await processInput(finalTranscript);
                console.log('LLM processed text:', processedText);

                // await synthesizeSpeech(processedText, ws);
                const audioBuffer = await synthesizeSpeech(processedText);
                if (audioBuffer) {
                  ws.send(JSON.stringify({
                    type: 'tts',
                    audio: audioBuffer.toString('base64'),
                    isFinal: true,
                    latency: latency.tts
                  }));
                }
              } catch (err) {
                console.error('Error in final processing:', err);
                ws.send(JSON.stringify({
                  type: 'tts_error',
                  error: 'Failed to process or synthesize speech'
                }));
              }












              transcriptBuffer = [];
            }
          }
        } else if (received.type === 'Metadata') {
          console.log('[Metadata]', received);
        }
      } catch (err) {
        console.error('[Deepgram Parse Error]', err);
      }
    });

    dgSocket.on('error', (err) => {
      console.error('❌ Deepgram WebSocket error:', err);
      handleReconnect();
    });

    dgSocket.on('close', () => {
      console.log("🔌 Deepgram WebSocket closed");
      handleReconnect();
    });
  };

  const handleReconnect = () => {
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      console.log(`Attempting to reconnect to Deepgram (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
      setTimeout(connectToDeepgram, RECONNECT_DELAY);
    } else {
      console.error('Max reconnection attempts reached');
      ws.send(JSON.stringify({ error: 'Failed to connect to transcription service' }));
    }
  };

  // Initial connection to Deepgram
  connectToDeepgram();

  // Collect VAD output and send to Deepgram in chunks
  let deepgramBuffer = Buffer.alloc(0);
  const CHUNK_SIZE = 6400; // Reduced chunk size for faster processing
  let isSpeechActive = false;

  vad.stdout.on('data', (data) => {
    try {
      const parsed = JSON.parse(data.toString());

      // Handle VAD events
      if (parsed.event === 'speech_start') {
        isSpeechActive = true;
        console.log('Speech started');
      } else if (parsed.event === 'speech_end') {
        isSpeechActive = false;
        console.log('Speech ended');

        // Force Deepgram to process final results
        if (dgSocket?.readyState === WebSocket.OPEN) {
          dgSocket.send(JSON.stringify({
            "type": "Finalize"
          }));
        }
      }

      // Process audio chunks
      if (parsed.chunk) {
        const audioBuffer = Buffer.from(parsed.chunk, 'hex');
        deepgramBuffer = Buffer.concat([deepgramBuffer, audioBuffer]);

        if (deepgramBuffer.length >= CHUNK_SIZE && dgSocket?.readyState === WebSocket.OPEN) {
          audioStartTime = Date.now();
          dgSocket.send(deepgramBuffer);
          deepgramBuffer = Buffer.alloc(0);
        }
      }
    } catch (err) {
      console.error('[VAD JSON Parse Error]', err);
    }
  });

  // Receive raw audio from client
  ws.on('message', (data) => {
    if (ffmpeg.stdin.writable) {
      ffmpeg.stdin.write(data);
    }
  });

  // Handle client disconnection
  ws.on('close', () => {
    console.log("👋 Client disconnected");
    cleanup();
  });

  // Handle client errors
  ws.on('error', (error) => {
    console.error('Client WebSocket error:', error);
    cleanup();
  });

  // Cleanup function
  const cleanup = () => {
    try {
      if (ffmpeg.stdin.writable) ffmpeg.stdin.end();
    } catch (e) {
      console.error('Error closing FFmpeg stdin:', e);
    }

    if (dgSocket?.readyState === WebSocket.OPEN) {
      dgSocket.close();
    }

    if (silenceTimer) {
      clearTimeout(silenceTimer);
    }
  };

  // Handle process termination
  process.on('SIGINT', () => {
    cleanup();
    process.exit();
  });

  async function processInput(input) {
    try {
      // console.log('Processing input through LLM:', input);
      let latency = Date.now();
      const response = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are a helpful assistant. Keep responses concise and natural. Keep responses short and concise."
          },
          {
            role: "user",
            content: input
          }
        ],
        max_tokens: 30,
        temperature: 0.1,
      });

      const processedText = response.choices[0].message.content;
      latency = Date.now() - latency;
      console.log('LLM latency:', latency);
      latency.llm = latency;
      // console.log('LLM processed text:', processedText);
      return processedText;
    } catch (error) {
      console.error('Error processing input through LLM:', error);
      return input; // Return original input if processing fails
    }
  }

  const synthesizeSpeech = async (text) => {
    if (!text) {
      console.error('No text provided for synthesis');
      return null;
    }

    console.log('Synthesizing speech for text:', text);
    const params = {
      Text: text,
      VoiceId: "Joanna",
      OutputFormat: "mp3"
    };

    try {
      let latency = Date.now();
      const command = new SynthesizeSpeechCommand(params);
      const data = await polly.send(command);
      latency = Date.now() - latency;
      console.log('TTS latency:', latency);
      latency.tts = latency;

      if (data.AudioStream) {
        const audioBuffer = Buffer.from(await data.AudioStream.transformToByteArray());
        return audioBuffer;
      } else {
        throw new Error("AudioStream not found in the response.");
      }
    } catch (err) {
      console.error("Error synthesizing speech:", err);
      throw err;
    }
  };
  // const synthesizeSpeech = async (text, ws) => {
  //   if (!text) return;

  //   const params = {
  //     Text: text,
  //     VoiceId: "Joanna",
  //     OutputFormat: "mp3"
  //   };

  //   const command = new SynthesizeSpeechCommand(params);
  //   const data = await polly.send(command);

  //   if (data.AudioStream) {
  //     // AudioStream is a readable stream
  //     const stream = data.AudioStream;
  //     stream.on('data', (chunk) => {
  //       ws.send(chunk); // Send each chunk as binary data
  //     });
  //     stream.on('end', () => {
  //       ws.send(JSON.stringify({ type: 'end' })); // Signal end of stream
  //     });
  //   }
  // };
});