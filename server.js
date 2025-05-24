const { spawn } = require('child_process');
const WebSocket = require('ws');
require('dotenv').config();
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
// const Speaker = require('speaker');
// const speaker = new Speaker({
//   channels: 1,
//   bitDepth: 16,
//   sampleRate: 16000
// });

const wss = new WebSocket.Server({ port: 5001 });
console.log("✅ WebSocket server started on ws://localhost:5001");

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
  const SILENCE_THRESHOLD = 1000; // 1 second of silence

  const connectToDeepgram = () => {
    if (dgSocket) {
      dgSocket.close();
    }

    dgSocket = new WebSocket(
      `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&model=nova&language=en&punctuate=true&interim_results=true&endpointing=500`,
      ['token', `${process.env.DEEPGRAM_API}`]
    );

    dgSocket.on('open', () => {
      console.log("✅ Deepgram WebSocket connected");
      reconnectAttempts = 0;
    });

    dgSocket.on('message', (data) => {
      try {
        const received = JSON.parse(data);
        if (received.channel?.alternatives?.[0]?.transcript) {
          const transcript = received.channel.alternatives[0].transcript;
          
          // Handle interim results
          if (!received.is_final) {
            ws.send(JSON.stringify({ 
              transcript: transcript,
              isInterim: true 
            }));
            return;
          }

          // Handle final results
          if (received.is_final) {
            // Clear silence timer when we get speech
            if (silenceTimer) {
              clearTimeout(silenceTimer);
              silenceTimer = null;
            }

            // Add to buffer if different from last transcript
            if (transcript !== lastTranscript) {
              transcriptBuffer.push(transcript);
              lastTranscript = transcript;
            }

            // Send buffered transcripts
            if (transcriptBuffer.length > 0) {
              ws.send(JSON.stringify({ 
                transcript: transcriptBuffer.join(' '),
                isFinal: true 
              }));
              transcriptBuffer = [];
            }

            // Start silence timer
            silenceTimer = setTimeout(() => {
              if (transcriptBuffer.length > 0) {
                ws.send(JSON.stringify({ 
                  transcript: transcriptBuffer.join(' '),
                  isFinal: true 
                }));
                transcriptBuffer = [];
              }
            }, SILENCE_THRESHOLD);
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
  const CHUNK_SIZE = 3200; // Reduced chunk size for faster processing

  vad.stdout.on('data', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      const speechDetected = parsed.timestamps.length > 0;

      if (speechDetected && parsed.chunk) {
        const audioBuffer = Buffer.from(parsed.chunk, 'hex');
        deepgramBuffer = Buffer.concat([deepgramBuffer, audioBuffer]);

        if (deepgramBuffer.length >= CHUNK_SIZE && dgSocket?.readyState === WebSocket.OPEN) {
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
});