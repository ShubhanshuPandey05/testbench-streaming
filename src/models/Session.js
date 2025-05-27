class Session {
    constructor(sessionId) {
        this.sessionId = sessionId;
        this.createdAt = new Date();
        this.lastActive = new Date();
        this.dgSocket = null;
        this.reconnectAttempts = 0;
        this.lastTranscript = '';
        this.transcriptBuffer = [];
        this.silenceTimer = null;
        this.audioStartTime = null;
        this.lastInterimTime = Date.now();
        this.isSpeaking = false;
        this.lastInterimTranscript = '';
        this.interimResultsBuffer = [];
    }

    updateLastActive() {
        this.lastActive = new Date();
    }

    reset() {
        this.dgSocket = null;
        this.reconnectAttempts = 0;
        this.lastTranscript = '';
        this.transcriptBuffer = [];
        this.silenceTimer = null;
        this.audioStartTime = null;
        this.lastInterimTime = Date.now();
        this.isSpeaking = false;
        this.lastInterimTranscript = '';
        this.interimResultsBuffer = [];
    }
}

module.exports = Session; 