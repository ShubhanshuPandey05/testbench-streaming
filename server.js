const { spawn } = require('child_process');
const WebSocket = require('ws');
require('dotenv').config();
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { PollyClient, SynthesizeSpeechCommand } = require("@aws-sdk/client-polly");
const OpenAI = require("openai");
const { full } = require('@huggingface/transformers');

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

let message = [
  {
    role: "system",
    content: `You are a helpful assistant.Always reply in JSON with two keys: 'output' (the answer) and 'outputType' (either 'text' or 'audio')And also give the response in short and concise manner.the prompt will be in the format of "{message:user_query, type:input_channel}" Always reply in JSON with two keys: 'output' (the answer) and 'outputType' (either 'text' or 'audio') This will be based on the user query, For each user query, decide if the response should be delivered as "text" or "audio" based on this rules. 1)Chosse "the input channel" for the outputtype most of the time but not always because if the user ask for a specific channel then you should choose that channel and also if the response is something which is not suitable for the input channel then you should select the output type as you needed. 2)Choose "text" for info like (emails, codes, etc.).`
  }
]

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
const pythonPath2 = 'D:/work/ship-fast.studio/Test_bench/python_processes/venv/Scripts/python.exe';

// Launch Python VAD script
const vad = spawn("python", ['vad.py']);

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

function generateSilenceBuffer(durationMs, sampleRate = 16000) {
  const numSamples = Math.floor((durationMs / 1000) * sampleRate);
  const buffer = Buffer.alloc(numSamples * 2); // 2 bytes per sample (16-bit PCM)
  return buffer;
}



// function isTurnComplete(
//   text,
//   minLength = 2,
//   maxLength = 100,
//   incompleteEndings = [
//     'and', 'but', 'or', 'so', 'because', 'although', 'though', 'if', 'when', 'while', 'since', 'unless',
//     'as', 'yet', 'until', 'except', 'plus', 'then', 'like', 'also', 'well', 'um', 'uh', 'like', 'could', "think"
//   ],
//   incompletePhrases = [
//     'you know', 'i mean', 'for example', 'such as', 'like i said', 'in other words', 'that is', 'for instance',
//     'i guess', 'i suppose', 'i think', 'i believe', 'i feel like', 'sort of', 'kind of', 'maybe', 'perhaps', 'to think', 'or else'
//   ]
// ) {
//   if (!text || typeof text !== 'string') return false;
//   text = text.trim();
//   if (!text) return false;

//   // Remove trailing filler words/phrases and re-trim
//   let lowered = text.toLowerCase().replace(/[\s,]*(um|uh|well|so|hmm|erm|ah|oh|like)[\s,]*$/i, '').trim();

//   // Check for ellipsis or unfinished punctuation
//   if (lowered.endsWith('...') || lowered.endsWith('--') || lowered.endsWith('-')) {
//     return false;
//   }

//   // Check for unclosed parentheses, quotes, or dashes
//   const openParens = (lowered.match(/\(/g) || []).length;
//   const closeParens = (lowered.match(/\)/g) || []).length;
//   const openQuotes = (lowered.match(/["']/g) || []).length;
//   if (openParens > closeParens || openQuotes % 2 !== 0) {
//     return false;
//   }

//   // Check for strong ending punctuation (but not if it's just a fragment)
//   if (/[.?!]$/.test(lowered)) {
//     // Ensure it's not just a fragment with punctuation
//     if (lowered.split(/\s+/).length >= minLength) return true;
//   }

//   // Check for incomplete ending words (e.g., "and", "but", etc.)
//   const words = lowered.split(/\s+/);
//   const lastWord = words[words.length - 1];
//   if (incompleteEndings.includes(lastWord)) {
//     return false;
//   }

//   // Check for incomplete phrases at the end
//   for (const phrase of incompletePhrases) {
//     if (lowered.endsWith(phrase)) {
//       return false;
//     }
//   }

//   // Check for minimum and maximum length
//   if (words.length < minLength) return false;
//   if (words.length > maxLength) return false;

//   // Check for common unfinished patterns
//   const unfinishedPatterns = [
//     /(i was going to|let me just|i think i|maybe we should|i just wanted to|i was about to|i was thinking|what i mean is|the thing is|the point is|i was saying)$/i,
//     /(do you know if|can you tell me if|i wonder if|if i can|I was thinking|trying to think that|like)$/i,
//     /(so,|well,|but,|and,)$/i
//   ];
//   for (const pattern of unfinishedPatterns) {
//     if (pattern.test(lowered)) {
//       return false;
//     }
//   }

//   // Check for abrupt cut-off (e.g., unfinished word at the end)
//   if (/[a-zA-Z]+-$/.test(lowered)) {
//     return false;
//   }

//   // Check for multi-sentence completeness (if more than one sentence, last should be complete)
//   const sentences = lowered.split(/[.?!]\s+/);
//   if (sentences.length > 1 && !/[.?!]$/.test(lowered)) {
//     return false;
//   }

//   // Default: treat as complete
//   return true;
// }

async function isTurnComplete(messages) {
  const res = await fetch("http://127.0.0.1:8000/predict_eot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });

  const json = await res.json();
  // console.log("EOT response:", json);
  return json.eot;
}

let fullMessage = "";

// Example: 500ms silence
const silenceBuffer = generateSilenceBuffer(100);

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
  let userSpeak = false;

  const connectToDeepgram = () => {
    if (dgSocket) {
      dgSocket.close();
    }

    dgSocket = new WebSocket(
      `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&model=nova-3&language=en&punctuate=true&interim_results=true&endpointing=50`,
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
              // console.log('Final transcript before LLM:', finalTranscript);
              userSpeak = true
              ws.send(JSON.stringify({
                transcript: finalTranscript,
                isFinal: true
              }));

              // Here we will impliment the logic of turn detection
              try {
                
                fullMessage = `${fullMessage} ${finalTranscript}`;
                
                message.push({
                  role: "user",
                  content: fullMessage
                });
                console.log("Full message:", message);

                const result = await isTurnComplete(message);
                // console.log("Full message:", fullMessage)
                if (result === true) {
                  // Process final transcript through LLM and then TTS
                  try {
                    console.log('Final transcript before LLM:', fullMessage);
                    const { processedText, outputType } = await processInput(`{message:${fullMessage}, type:'audio'}`);
                    // console.log('LLM processed text:', processedText);

                    // await synthesizeSpeech(processedText, ws);
                    if (outputType === 'audio') {
                      console.log("tts called")
                      const audioBuffer = await synthesizeSpeechWithPolly(processedText);
                      if (audioBuffer) {
                        // console.log("audio buffer")
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
                  fullMessage = ""
                } else {
                  console.log("user may speak further but if not in 3 seconds we will continue with this message");
                  userSpeak = false
                  setTimeout(async() => {
                    if (userSpeak === false) {
                      try {
                        console.log('Final transcript before LLM:', finalTranscript);
                        const { processedText, outputType } = await processInput(`{message:${fullMessage}, type:'audio'}`);
                        // console.log('LLM processed text:', processedText);

                        // await synthesizeSpeech(processedText, ws);
                        if (outputType === 'audio') {
                          console.log("tts called")
                          const audioBuffer = await synthesizeSpeechWithPolly(processedText);
                          if (audioBuffer) {
                            // console.log("audio buffer")
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
                      fullMessage = ""
                    }
                  }, 3000)

                }

              } catch (error) {
              }



              // try {
              //   console.log('Final transcript before LLM:', finalTranscript);
              //   const { processedText, outputType } = await processInput(`{message:${finalTranscript}, type:'audio'}`);
              //   // console.log('LLM processed text:', processedText);

              //   // await synthesizeSpeech(processedText, ws);
              //   if (outputType === 'audio') {
              //     console.log("tts called")
              //     const audioBuffer = await synthesizeSpeechWithPolly(processedText);
              //     if (audioBuffer) {
              //       // console.log("audio buffer")
              //       ws.send(JSON.stringify({
              //         type: 'audio',
              //         audio: audioBuffer.toString('base64'),
              //         isFinal: true,
              //         latency: latencyObj
              //       }));
              //     }
              //   } else {
              //     ws.send(JSON.stringify({
              //       type: 'text',
              //       text: processedText,
              //       isFinal: true,
              //       latency: latencyObj
              //     }));
              //   }
              //   // console.log('latency', latency);
              // } catch (err) {
              //   console.error('Error in final processing:', err);
              //   ws.send(JSON.stringify({
              //     type: 'tts_error',
              //     error: 'Failed to process or synthesize speech'
              //   }));
              // }

              // try {
              //   message.push({
              //     role: "user",
              //     content: finalTranscript
              //   })
              //   const fedData = {
              //     role: "user",
              //     content: finalTranscript
              //   }

              //   isTurnComplete(fedData)
                
              // } catch (error) {

              // }

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
  let silenceTime = 0

  setInterval(() => {
    if (!isSpeechActive) {
      dgSocket.send(JSON.stringify({
        "type": "KeepAlive"
      }));
      // console.log('KeepAlive sent');
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
        if (isSpeechActive === false && dgSocket?.readyState === WebSocket.OPEN) {
          // dgSocket.send(silenceBuffer)
          dgSocket.send(JSON.stringify({
            "type": "Finalize"
          }));
        }

        // setTimeout(() => {
        //   if (isSpeechActive === false && dgSocket?.readyState === WebSocket.OPEN) {
        //     // dgSocket.send(silenceBuffer)
        //     dgSocket.send(JSON.stringify({
        //       "type": "Finalize"
        //     }));
        //   }
        // },1000)
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
            const audioBuffer = await synthesizeSpeechWithPolly(processedText);
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
        console.log(`{message:'${parsedData.message}', type:'${parsedData.type}'}`);
        generateResponse(`{message:'${parsedData.message}', type:'${parsedData.type}}'`);
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


    // console.log(message)

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
      console.log(data.choices[0].message.content)
      try {
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
        console.error('Error parsing LLM response:', error);
        if (data.choices[0].message.content) {
          return { processedText: data.choices[0].message.content, outputType: 'audio' };
        }
        return { processedText: input, outputType: 'audio' }; // fallback

      }

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

  const synthesizeSpeechWithPolly = async (text) => {
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

  const synthesizeSpeechWithGabber = async (text) => {
    try {
      // console.log(process.env.GABBER_USAGETOKEN)
      let latency = Date.now();
      const response = await fetch('https://api.gabber.dev/v1/voice/generate', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GABBER_USAGETOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          'voice_id': process.env.GABBER_VOICEID_FEMALE,
        })
      });

      console.log(response)
      latency = Date.now() - latency;
      console.log('TTS latency:', latency);
      latencyObj.tts = latency;


      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`❌ Failed: ${response.status} - ${errorText}`);
      }

      const arrayBuffer = await response.arrayBuffer();

      const buffer = Buffer.from(arrayBuffer);
      return buffer;
    } catch (err) {
      const raw = err.response?.data;
      const decoded = raw && Buffer.isBuffer(raw)
        ? raw.toString()
        : JSON.stringify(raw);

      console.error('❌ Error:', decoded || err.message);
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