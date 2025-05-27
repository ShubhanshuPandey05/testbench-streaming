require('dotenv').config();

module.exports = {
    // WebSocket Configuration
    WS_PORT: 5001,
    
    // Deepgram Configuration
    DEEPGRAM_CONFIG: {
        encoding: 'linear16',
        sample_rate: 16000,
        channels: 1,
        model: 'nova-3',
        language: 'en',
        punctuate: true,
        interim_results: true,
        endpointing: 100
    },

    // VAD Configuration
    VAD_CONFIG: {
        threshold: 0.3,
        prefix_duration: 0.1,
        sample_rate: 16000
    },

    // Session Configuration
    SESSION_CONFIG: {
        maxInactiveTime: 30 * 60 * 1000, // 30 minutes
        cleanupInterval: 5 * 60 * 1000   // 5 minutes
    },

    // Speech Processing Configuration
    SPEECH_CONFIG: {
        silenceThreshold: 500,           // 500ms
        interimConfidenceThreshold: 0.7,
        interimTimeThreshold: 10
    },

    // AWS Configuration
    AWS_CONFIG: {
        region: "us-east-1",
        credentials: {
            accessKeyId: process.env.accessKeyId,
            secretAccessKey: process.env.secretAccessKey
        }
    },

    // OpenAI Configuration
    OPENAI_CONFIG: {
        apiKey: process.env.OPEN_AI
    }
}; 