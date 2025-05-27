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

let latencyObj = {
  llm: 0,
  stt: 0,
  tts: 0,
};

// let outputType = 'audio';

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
                const { processedText, outputType } = await processInput(finalTranscript);
                console.log('LLM processed text:', processedText);

                // await synthesizeSpeech(processedText, ws);
                if (outputType === 'audio') {
                  const audioBuffer = await synthesizeSpeech(processedText);
                  if (audioBuffer) {
                    ws.send(JSON.stringify({
                      type: 'audio',
                      audio: audioBuffer.toString('base64'),
                      isFinal: true,
                      latency: latencyObj
                    }));
                  }
                } else {
                  ws.send(JSON.stringify({
                    type: 'text',
                    text: processedText,
                    isFinal: true,
                    latency: latencyObj
                  }));
                }
                // console.log('latency', latency);
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

  setInterval(() => {
    if (!isSpeechActive) {
      dgSocket.send(JSON.stringify({
        "type": "KeepAlive"
      }));
      console.log('KeepAlive sent');
    }
  }, 10000);

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
    try {
      const parsedData = JSON.parse(data);
      if (parsedData.type === 'chat') {
        console.log('Received chat message:', parsedData.message);
        async function generateResponse(input) {
          const { processedText, outputType } = await processInput(input);
          console.log('LLM processed text:', processedText);
          if (outputType === 'text') {
            ws.send(JSON.stringify({
              type: 'text',
              text: processedText,
              isFinal: true,
              latency: latencyObj
            }));
          } else if (outputType === 'audio') {
            const audioBuffer = await synthesizeSpeech(processedText);
            if (audioBuffer) {
              ws.send(JSON.stringify({
                type: 'audio',
                audio: audioBuffer.toString('base64'),
                isFinal: true,
                latency: latencyObj
              }));
            }
          }
        }
        generateResponse(parsedData.message);
      }
    } catch (err) {
      if (ffmpeg.stdin.writable) {
        ffmpeg.stdin.write(data);
      }
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

  // async function processInput(input) {
  //   const apiKey = process.env.OPEN_AI; // Replace with your actual API key
  //   const url = 'https://api.openai.com/v1/chat/completions';

  //   const payload = {
  //     model: "gpt-4o-mini", // or gpt-4-1106-preview, depending on what's available
  //     messages: [
  //       {
  //         role: "system",
  //         content: "You are a helpful assistant. Keep responses concise and natural. Keep responses short and concise."
  //       },
  //       {
  //         role: "user",
  //         content: input
  //       }
  //     ],
  //     max_tokens: 30,
  //     temperature: 0.1
  //   };

  //   try {
  //     let latency = Date.now();

  //     const response = await fetch(url, {
  //       method: 'POST',
  //       headers: {
  //         'Content-Type': 'application/json',
  //         'Authorization': `Bearer ${apiKey}`
  //       },
  //       body: JSON.stringify(payload)
  //     });

  //     const data = await response.json();
  //     latency = Date.now() - latency;
  //     console.log('LLM latency:', latency);
  //     latencyObj.llm = latency;

  //     const processedText = data.choices[0].message.content;
  //     return processedText;

  //   } catch (error) {
  //     console.error('Error processing input through LLM:', error);
  //     return input; // fallback
  //   }
  // }


  let message = [
    {
      role: "system",
      content: `You are a helpful assistant. Always reply in JSON with two keys: 'output' (the answer) and 'outputType' (either 'text' or 'audio') This will be based on the user query, For each user query, decide if the response should be delivered as "text" or "audio". 
- Choose "text" for sensitive info (emails, codes, etc.).
- Choose "audio" for general or conversational replies.. And also give the response in short and concise manner."`
    }
  ]


  async function processInput(input) {
    const apiKey = process.env.OPEN_AI;
    const url = 'https://api.openai.com/v1/chat/completions';

    // Tool definition
    // const tools = [
    //   {
    //     type: "function",
    //     function: {
    //       name: "setOutputType",
    //       description: "Decide whether the response should be delivered as text or audio.",
    //       parameters: {
    //         type: "object",
    //         properties: {
    //           outputType: {
    //             type: "string",
    //             enum: ["text", "audio"],
    //             description: "The preferred output type for this response."
    //           },
    //           reason: {
    //             type: "string",
    //             description: "A brief explanation for choosing this output type."
    //           }
    //         },
    //         required: ["outputType"]
    //       }
    //     }
    //   }
    // ];

    // System prompt
    //   const systemPrompt = `
    // You are a helpful assistant. 
    // Keep responses concise and natural.
    // And also give the response in short and concise manner.
    // For each user query, decide if the response should be delivered as "text" or "audio". 
    // Use the setOutputType tool:
    // - Choose "text" for sensitive info (emails, codes, etc.).
    // - Choose "audio" for general or conversational replies.
    // `;


    message.push({
      role: "user",
      content: input
    })

    const payload = {
      model: "gpt-4o-mini",
      messages: message,
      // tools: tools,
      max_tokens: 100, // Increase if you expect tool call + reasoning
      temperature: 0.1
    };

    try {
      let latency = Date.now();

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();
      latency = Date.now() - latency;
      console.log('LLM latency:', latency);
      latencyObj.llm = latency;

      // Check for tool calls in the response
      let outputType = 'audio'; // default
      // if (data.choices[0].message.tool_calls) {
      //   const toolCall = data.choices[0].message.tool_calls.find(tc => tc.function.name === "setOutputType");
      //   if (toolCall) {
      //     const args = JSON.parse(toolCall.function.arguments);
      //     outputType = args.outputType;
      //     console.log("LLM decided outputType:", outputType, "| Reason:", args.reason);
      //   }
      // }
      // console.log(data.choices[0].message.content)
      const parsedData = JSON.parse(data.choices[0].message.content);
      outputType = parsedData.outputType;
      console.log("LLM decided outputType:", outputType, "| Reason:", parsedData.reason);
      const processedText = parsedData.output;
      message.push({
        role: "assistant",
        content: processedText
      })
      // You can now use outputType in your code as needed
      return { processedText, outputType };

    } catch (error) {
      console.error('Error processing input through LLM:', error);
      return { processedText: input, outputType: 'text' }; // fallback
    }
  }


  // async function processInput(input) {
  //   try {
  //     // console.log('Processing input through LLM:', input);
  //     let latency = Date.now();
  //     const response = await client.chat.completions.create({
  //       model: "gpt-4o-mini",
  //       messages: [
  //         {
  //           role: "system",
  //           content: "You are a helpful assistant. Keep responses concise and natural. Keep responses short and concise."
  //         },
  //         {
  //           role: "user",
  //           content: input
  //         }
  //       ],
  //       max_tokens: 30,
  //       temperature: 0.1,
  //     });

  //     const processedText = response.choices[0].message.content;
  //     latency = Date.now() - latency;
  //     console.log('LLM latency:', latency);
  //     latencyObj.llm = latency;
  //     // console.log('LLM processed text:', processedText);
  //     return processedText;
  //   } catch (error) {
  //     console.error('Error processing input through LLM:', error);
  //     return input; // Return original input if processing fails
  //   }
  // }

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
      latencyObj.tts = latency;

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