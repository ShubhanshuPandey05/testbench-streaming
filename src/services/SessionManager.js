const Session = require('../models/Session');

class SessionManager {
    constructor() {
        this.sessions = new Map();
    }

    createSession(sessionId) {
        const session = new Session(sessionId);
        this.sessions.set(sessionId, session);
        return session;
    }

    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }

    removeSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            if (session.dgSocket) {
                session.dgSocket.close();
            }
            this.sessions.delete(sessionId);
        }
    }

    updateSessionActivity(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.updateLastActive();
        }
    }

    cleanupInactiveSessions(maxInactiveTime = 30 * 60 * 1000) { // 30 minutes default
        const now = Date.now();
        for (const [sessionId, session] of this.sessions.entries()) {
            if (now - session.lastActive > maxInactiveTime) {
                this.removeSession(sessionId);
            }
        }
    }
}

module.exports = new SessionManager(); 