// Core Dependencies
const { spawn } = require('child_process');
const WebSocket = require('ws');
require('dotenv').config(); // Make sure your .env file has all the necessary keys
const { PollyClient, SynthesizeSpeechCommand } = require("@aws-sdk/client-polly");
const OpenAI = require("openai");
const twilio = require('twilio'); // This might not be directly used in the WebSocket server, but kept for consistency


const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const graphqlEndpoint = `https://${SHOPIFY_STORE_URL}/admin/api/2023-01/graphql.json`;
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const PROTO_PATH = './turn.proto';

// Load proto file
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
});
const turnProto = grpc.loadPackageDefinition(packageDefinition).turn;

const turnDetector = new turnProto.TurnDetector(
    'localhost:50051',
    grpc.credentials.createInsecure()
);




const toolDefinitions = [
    {
        type: "function",
        name: "getAllProducts",
        description: "Get a list of all products in the store.",
        parameters: {
            type: "object",
            properties: {},
            required: []
        }
    },
    {
        type: "function",
        name: "getUserDetailsByPhoneNo",
        description: "Get customer details",
        parameters: {
            type: "object",
            properties: {},
            required: []
        }
    },
    {
        type: "function",
        name: "getAllOrders",
        description: "Get a list of all orders.",
        parameters: {
            type: "object",
            properties: {},
            required: []
        }
    },
    {
        type: "function",
        name: "getOrderById",
        description: "Get details for a specific order by its ID.",
        parameters: {
            type: "object",
            properties: {
                orderId: { type: "string", description: "The Shopify order ID." }
            },
            required: ["orderId"]
        }
    }
];

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

const functions = {
    async getAllProducts(cursor = null) {
        const query = `
    {
      products(first: 50${cursor ? `, after: "${cursor}"` : ''}) {
        edges {
          cursor
          node {
            id
            title
            handle
            description
            variants(first: 10) {
              edges {
                node {
                  id
                  title
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  `;

        const response = await fetch(graphqlEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            },
            body: JSON.stringify({ query }),
        });

        const data = await response.json();
        if (!data.data || !data.data.products) return { products: [], hasNextPage: false, lastCursor: null };

        const products = data.data.products.edges.map(edge => ({
            id: edge.node.id,
            title: edge.node.title,
            handle: edge.node.handle,
            description: edge.node.description,
            variants: edge.node.variants.edges.map(variantEdge => ({
                id: variantEdge.node.id,
                title: variantEdge.node.title
            }))
        }));

        const hasNextPage = data.data.products.pageInfo.hasNextPage;
        const lastCursor = data.data.products.edges.length > 0 ? data.data.products.edges[data.data.products.edges.length - 1].cursor : null;

        // console.log(products)

        return products;
    },

    async getUserDetailsByPhoneNo(phone) {
        const query = `
        {
          customers(first: 1, query: "phone:${phone}") {
            edges {
              node {
                id
                firstName
                lastName
                email
                phone
                numberOfOrders
              }
            }
          }
        }
        `;

        const response = await fetch(graphqlEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            },
            body: JSON.stringify({ query }),
        });

        const data = await response.json();
        if (!data.data || !data.data.customers.edges.length) return null;

        const user = data.data.customers.edges[0].node;
        return {
            id: user.id,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            phone: user.phone,
            ordersCount: user.ordersCount
        };
    },

    // async getUserDetailsByPhoneNo(phone) {
    //     try {
    //         // console.log(`http://localhost:3000/getuser/search?${encodeURIComponent(phone)}`)
    //         const response = await fetch(`http://localhost:3000/getuser/search?phone=${encodeURIComponent(phone)}`);

    //         if (!response.ok) {
    //             console.error('User not found or error occurred:', response.status);
    //             return null;
    //         }

    //         const user = await response.json();
    //         console.log(user[0].name)
    //         return {
    //             id: user[0].user_id,
    //             name: user[0].name,
    //             email: user[0].email,
    //             phone: user[0].phone,// Optional, if you have this in DB
    //         };
    //     } catch (error) {
    //         console.error('❌ Error fetching user by phone from API:', error);
    //         return null;
    //     }
    // },

    async getAllOrders(cursor = null) {
        const query = `
    {
      orders(first: 50${cursor ? `, after: "${cursor}"` : ''}) {
        edges {
          cursor
          node {
            id
            name
            email
            phone
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            createdAt
            fulfillmentStatus
            lineItems(first: 10) {
              edges {
                node {
                  title
                  quantity
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  `;

        const response = await fetch(graphqlEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            },
            body: JSON.stringify({ query }),
        });

        const data = await response.json();
        if (!data.data || !data.data.orders) return { orders: [], hasNextPage: false, lastCursor: null };

        const orders = data.data.orders.edges.map(edge => ({
            id: edge.node.id,
            name: edge.node.name,
            email: edge.node.email,
            phone: edge.node.phone,
            total: edge.node.totalPriceSet.shopMoney.amount,
            currency: edge.node.totalPriceSet.shopMoney.currencyCode,
            createdAt: edge.node.createdAt,
            fulfillmentStatus: edge.node.fulfillmentStatus,
            lineItems: edge.node.lineItems.edges.map(itemEdge => ({
                title: itemEdge.node.title,
                quantity: itemEdge.node.quantity
            }))
        }));

        const hasNextPage = data.data.orders.pageInfo.hasNextPage;
        const lastCursor = data.data.orders.edges.length > 0 ? data.data.orders.edges[data.data.orders.edges.length - 1].cursor : null;

        return { orders, hasNextPage, lastCursor };
    },

    async getOrderById(orderId) {
        const query = `
    {
      order(id: "${orderId}") {
        id
        name
        email
        phone
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        createdAt
        fulfillmentStatus
        lineItems(first: 10) {
          edges {
            node {
              title
              quantity
            }
          }
        }
      }
    }
  `;

        const response = await fetch(graphqlEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            },
            body: JSON.stringify({ query }),
        });

        const data = await response.json();
        if (!data.data || !data.data.order) return null;

        const order = data.data.order;
        return {
            id: order.id,
            name: order.name,
            email: order.email,
            phone: order.phone,
            total: order.totalPriceSet.shopMoney.amount,
            currency: order.totalPriceSet.shopMoney.currencyCode,
            createdAt: order.createdAt,
            fulfillmentStatus: order.fulfillmentStatus,
            lineItems: order.lineItems.edges.map(itemEdge => ({
                title: itemEdge.node.title,
                quantity: itemEdge.node.quantity
            }))
        };
    }
}

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
            userPhoneno: null,
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
            ASSISTANT_ID: null,
            lastResponseId: null,
            threadId: null,
            phoneNo: '',
            currentMessage: {},
            chatHistory: [{
                role: 'assistant',
                content: "Hello! You are speaking to an AI assistant for Gautam Garment."
            }],
            prompt: `You are a helpful AI assistant for the Shopify store "Gautam Garment". You have access to several tools (functions) that let you fetch and provide real-time information about products, orders, and customers from the store.

Your Tasks:

Understand the user's message and intent.
If you need specific store data (like product lists, order details, or customer info), use the available tools by calling the appropriate function with the required parameters.
After receiving tool results, use them to generate a helpful, concise, and accurate response for the user.
Always return your answer in JSON format with two fields:
"response": your textual reply for the user
"output_channel": the medium for your response (currently, only "audio" is available)

Example Output:
{
"response": "Here are the top 5 products from Gautam Garment.",
"output_channel": "audio"
}

User Input Format:
The user's message will be a JSON object with "message" and "input_channel", for example:
{
"message": "Show me my recent orders",
"input_channel": "audio"
}

Available Tools (functions):
getAllProducts: Get a list of all products in the store.
getUserDetailsByPhoneNo: Get customer details by phone number.
getAllOrders: Get a list of all orders.
getOrderById: Get details for a specific order by its ID.

Instructions:
If a user's request requires store data, call the relevant tool first, then use its result in your reply.
If the user asks a general question or your response does not require real-time store data, answer directly.
Always use the user's input_channel for your response if it matches the available output channels (currently, only "audio").
The store name is "Gautam Garment"—refer to it by name in your responses when appropriate.`,
            metrics: { llm: 0, stt: 0, tts: 0 },

            // Per-session child processes for audio handling
            ffmpegProcess: null,
            vadProcess: null,
            turndetectionprocess: null,
            vadDeepgramBuffer: Buffer.alloc(0), // Buffer for audio chunks after VAD/FFmpeg processing
            isVadSpeechActive: false,
            currentUserUtterance: '', // VAD's internal speech detection status
            isTalking: false
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
        const CHUNK_SIZE_MULAW = 800; // 20ms of 8khz mulaw (8000 samples/sec * 0.020 sec = 160 samples, 1 byte/sample)
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
                setTimeout(sendChunk, 100); // 180ms delay for 200ms chunk
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
    // async processInput(input, session) {
    //     try {
    //         session.currentMessage = input;
    //         session.chatHistory.push({ U: input.message });

    //         // Prepare messages for OpenAI
    //         const messages = [
    //             { role: "system", content: session.prompt },
    //             { role: "user", content: JSON.stringify({ chatHistory: session.chatHistory, currentMessage: session.currentMessage }) }
    //         ];

    //         const startTime = Date.now();
    //         const response = await services.openai.chat.completions.create({
    //             model: CONFIG.GPT_MODEL,
    //             messages: messages,
    //             temperature: CONFIG.GPT_TEMPERATURE,
    //             max_tokens: CONFIG.GPT_MAX_TOKENS,
    //             response_format: { type: "json_object" } // Request JSON object directly
    //         });
    //         const latency = Date.now() - startTime;
    //         session.metrics.llm = latency;

    //         let parsedData;
    //         try {
    //             parsedData = JSON.parse(response.choices[0].message.content);
    //             console.log(`Session ${session.id}: LLM Raw Response:`, response.choices[0].message.content);
    //             console.log(`Session ${session.id}: Parsed LLM response:`, parsedData.response);
    //             console.log(`Session ${session.id}: Parsed LLM output channel:`, parsedData.output_channel);
    //             session.chatHistory.push({ A: parsedData.response });
    //             return { processedText: parsedData.response, outputType: parsedData.output_channel };
    //         } catch (error) {
    //             console.error(`Session ${session.id}: Error parsing LLM JSON response:`, error);
    //             console.log(`Session ${session.id}: Attempting to use raw LLM content:`, response.choices[0].message.content);
    //             session.chatHistory.push({ A: response.choices[0].message.content });
    //             // Fallback if JSON parsing fails
    //             return {
    //                 processedText: response.choices[0].message.content || "Sorry, I had trouble understanding. Could you please rephrase?",
    //                 outputType: 'audio' // Default to audio if parsing fails
    //             };
    //         }
    //     } catch (error) {
    //         console.error(`Session ${session.id}: Error processing input with OpenAI:`, error);
    //         // Fallback for API errors
    //         return { processedText: "I'm having trouble connecting right now. Please try again later.", outputType: 'audio' };
    //     }
    // },

    async processInput(input, session) {
        // On the first user message, previous_response_id will be undefined.
        // On subsequent turns, set previous_response_id to maintain context.


        const createResponseParams = {
            model: "gpt-4o-mini", // required
            input: input.message, // required
            instructions: session.prompt,
            tools: toolDefinitions
        };
        if (session.lastResponseId) {
            createResponseParams.previous_response_id = session.lastResponseId;
        }

        // Send the user's message to OpenAI
        let response = await services.openai.responses.create(createResponseParams);

        // Save the latest response ID for continuity
        session.lastResponseId = response.id;
        // console.log(response)

        if (response.output[0].type === "function_call") {
            const tool = []
            let toolResult;

            if (response.output[0].name === "getAllProducts") {
                toolResult = await functions.getAllProducts();
            } else if (response.output[0].name === "getUserDetailsByPhoneNo") {
                toolResult = await functions.getUserDetailsByPhoneNo(session.caller);
            } else if (response.output[0].name === "getAllOrders") {
                toolResult = await functions.getAllOrders();
            } else if (response.output[0].name === "getOrderById") {
                toolResult = await functions.getOrderById(args.orderId);
            } else {
                toolResult = { error: "Unknown tool requested." };
            }
            // console.log(toolResult)
            // console.log(response.output)

            tool.push({
                type: "function_call_output",
                call_id: response.output[0].call_id,
                output: JSON.stringify({ toolResult })
            });
            // console.log(message)
            response = await services.openai.responses.create({
                model: "gpt-4o-mini",
                instructions: session.prompt,
                input: tool,
                previous_response_id: session.lastResponseId // chain for context
            });
            session.lastResponseId = response.id;

        }




        // Extract the assistant's latest 


        // session.lastResponseId = response.id;

        const messages = response.output || [];
        const assistantMessage = messages.find(m => m.role === "assistant");

        let parsedData;
        try {
            parsedData = JSON.parse(assistantMessage.content[0].text);
            return { processedText: parsedData.response, outputType: parsedData.output_channel };
        } catch (error) {
            return {
                processedText: assistantMessage.content[0].text || "Sorry, I had trouble understanding. Could you please rephrase?",
                outputType: 'audio'
            };
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
wss.on('connection', (ws, req) => {
    console.log("🎧 New client connected.");
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

    async function handleTurnCompletion(session) {
        const finalTranscript = session.currentUserUtterance;
        if (!finalTranscript) return; // Do nothing if there's no transcript

        // console.log(`Session ${session.id}: Turn complete. Processing final transcript: "${finalTranscript}"`);

        // 1. Add the complete user message to the official chat history
        session.chatHistory.push({ role: 'user', content: finalTranscript });

        // 2. Reset the utterance buffer for the next turn
        session.currentUserUtterance = '';

        // // 3. Send final transcript to client for display (optional, but good practice)
        // ws.send(JSON.stringify({
        //     type: 'final_transcript',
        //     transcript: finalTranscript,
        //     isFinal: true
        // }));

        try {
            // 4. Get the AI's response
            const { processedText, outputType } = await aiProcessing.processInput(
                { message: finalTranscript, input_channel: 'audio' },
                session
            );

            // 5. Add AI response to chat history
            session.chatHistory.push({ role: 'assistant', content: processedText });

            if (outputType === 'audio') {
                // Your existing audio response logic
                handleInterruption(session); // Stop any ongoing AI speech
                const audioBuffer = await aiProcessing.synthesizeSpeech(processedText, session.id);
                if (!audioBuffer) throw new Error("Failed to synthesize speech.");

                const mulawBuffer = await audioUtils.convertMp3ToMulaw(audioBuffer, session.id);
                if (mulawBuffer) {
                    session.interruption = false;
                    audioUtils.streamMulawAudioToTwilio(ws, session.streamSid, mulawBuffer, session);
                } else {
                    throw new Error("Failed to convert audio to mulaw.");
                }
            } else {
                // Handle text output
                ws.send(JSON.stringify({
                    type: 'ai_response_text',
                    text: processedText,
                }));
                session.isAIResponding = false;
            }
        } catch (err) {
            console.error(`Session ${session.id}: Error during turn completion handling:`, err);
            ws.send(JSON.stringify({ type: 'error', error: err.message }));
            session.isAIResponding = false;
        }
    }


    // REFACTORED: Your connectToDeepgram function with turn detection integrated.
    const connectToDeepgram = (currentSession) => { // Pass 'ws' as an argument
        if (!currentSession || !currentSession.id) {
            console.error('Attempted to connect to Deepgram without a valid session.');
            return;
        }

        if (currentSession.dgSocket && currentSession.dgSocket.readyState === WebSocket.OPEN) {
            currentSession.dgSocket.close();
        }

        currentSession.dgSocket = new WebSocket(
            `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&model=nova-3&language=en&punctuate=true&interim_results=true&endpointing=200`,
            ['token', `${process.env.DEEPGRAM_API}`]
        );

        currentSession.dgSocket.on('open', () => {
            console.log(`Session ${currentSession.id}: ✅ Deepgram connected.`);
        });

        currentSession.dgSocket.on('message', async (data) => {
            try {
                const received = JSON.parse(data);
                const transcript = received.channel?.alternatives?.[0]?.transcript;

                if (!transcript) return;

                // --- THIS IS THE CORE LOGIC CHANGE ---
                if (received.is_final) {
                    // A segment of speech has ended. We now check if it completes the user's turn.
                    currentSession.isTalking = true
                    currentSession.isSpeaking = false;
                    currentSession.lastInterimTranscript = '';

                    // 1. Append the new final segment to the ongoing utterance buffer.
                    currentSession.currentUserUtterance += (currentSession.currentUserUtterance ? ' ' : '') + transcript;
                    console.log(`Session ${currentSession.id}: Received final segment. Current utterance: "${currentSession.currentUserUtterance}"`);

                    // 2. Prepare the conversation history for the turn detector.
                    if (currentSession.chatHistory.length > 8) {
                        currentSession.chatHistory.shift()
                    }
                    const messagesForDetection = [
                        ...currentSession.chatHistory,
                        { role: 'user', content: currentSession.currentUserUtterance }
                    ];
                    console.log(messagesForDetection);

                    // 3. Ask the service if the turn is complete.
                    // const isComplete = await turnDetector.CheckEndOfTurn({ messages: messagesForDetection })

                    turnDetector.CheckEndOfTurn({ messages: messagesForDetection }, (err, response) => {
                        (async () => {
                            if (err) {
                                console.error('❌ gRPC Error:', err);
                            } else {
                                if (response.end_of_turn) {
                                    // YES, the turn is complete. Process the full utterance.
                                    console.log(`Session ${currentSession.id}: ✅ Turn complete. Waiting for more input.`);
                                    if (!currentSession.isVadSpeechActive) {
                                        await handleTurnCompletion(currentSession);

                                    }
                                } else {
                                    // NO, the user just paused. Wait for them to continue.
                                    console.log(`Session ${currentSession.id}: ⏳ Turn NOT complete. Waiting for more input.`);
                                    currentSession.isTalking = false
                                    setTimeout(async () => {
                                        if (!currentSession.isTalking && !currentSession.isVadSpeechActive) {
                                            await handleTurnCompletion(currentSession)
                                        }
                                    }, 5000)
                                }
                            }
                        })();
                    });

                    // if (isComplete.end_of_turn) {
                    //     // YES, the turn is complete. Process the full utterance.
                    //     await handleTurnCompletion(currentSession);
                    // } else {
                    //     // NO, the user just paused. Wait for them to continue.
                    //     console.log(`Session ${currentSession.id}: ⏳ Turn NOT complete. Waiting for more input.`);
                    // }

                } else { // This is an interim result.
                    // Interim logic remains the same - it's great for UI feedback.
                    if (transcript.trim() && transcript !== currentSession.lastInterimTranscript) {
                        currentSession.isSpeaking = true;
                        currentSession.lastInterimTranscript = transcript;
                        ws.send(JSON.stringify({
                            type: 'interim_transcript',
                            transcript: transcript
                        }));
                    }
                }
            } catch (err) {
                console.error(`Session ${currentSession.id}: Deepgram message parse error:`, err);
            }
        });

        currentSession.dgSocket.on('error', (err) => {
            console.error(`Session ${currentSession.id}: Deepgram error:`, err);
        });

        currentSession.dgSocket.on('close', () => {
            console.log(`Session ${currentSession.id}: Deepgram connection closed.`);
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
                // console.log('start',parsedData);
                sessionId = parsedData.streamSid;
                session = sessionManager.createSession(sessionId, ws); // Pass ws to session manager
                session.callSid = parsedData.start.callSid;
                session.streamSid = parsedData.streamSid; // Confirm streamSid in session
                session.caller = parsedData.start.customParameters.caller;
                // console.log(session.caller);
                console.log(`Session ${sessionId}: Twilio stream started for CallSid: ${session.callSid}`);
                // console.log(parsedData.caller);

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

                const userDetails = await functions.getUserDetailsByPhoneNo(session.caller);
                // console.log(userDetails);
                let announcementText = session.chatHistory[0].content; // Get initial message from chat history
                if (userDetails) {
                    announcementText = `Hello ${userDetails.firstName}, welcome to the Gautam Garments. How can I help you today?`;
                }

                const mp3Buffer = await aiProcessing.synthesizeSpeech(announcementText, session.id);
                if (mp3Buffer) {
                    const mulawBuffer = await audioUtils.convertMp3ToMulaw(mp3Buffer, session.id);
                    if (mulawBuffer) {
                        audioUtils.streamMulawAudioToTwilio(ws, session.streamSid, mulawBuffer, session);
                    }
                }

            } else if (parsedData.event === 'media' && parsedData.media?.payload) {

                // console.log('mediaEvent : ',parsedData);
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