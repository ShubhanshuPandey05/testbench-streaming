const { spawn } = require('child_process');
const config = require('../config/config');

class AudioProcessor {
    constructor() {
        this.ffmpeg = null;
        this.vad = null;
        this.initializeProcesses();
    }

    initializeProcesses() {
        // Initialize FFmpeg process
        this.ffmpeg = spawn('ffmpeg', [
            '-loglevel', 'quiet',
            '-i', 'pipe:0',
            '-f', 's16le',
            '-acodec', 'pcm_s16le',
            '-ac', '1',
            '-ar', '16000',
            '-threads', '0',
            '-af', 'highpass=f=200,lowpass=f=3000',
            'pipe:1'
        ]);

        // Initialize VAD process
        const pythonPath = 'C:/Users/shubh/miniconda3/envs/vad-env/python.exe';
        this.vad = spawn(pythonPath, ['vad.py']);

        // Set up piping
        this.ffmpeg.stdout.pipe(this.vad.stdin);

        // Error handling
        this.ffmpeg.stderr.on('data', (data) => console.error(`FFmpeg error: ${data}`));
        this.vad.stderr.on('data', (data) => console.error(`VAD error: ${data}`));

        this.ffmpeg.on('error', (err) => console.error('FFmpeg process error:', err));
        this.vad.on('error', (err) => console.error('VAD process error:', err));

        this.ffmpeg.on('exit', (code) => console.log(`FFmpeg process exited with code ${code}`));
        this.vad.on('exit', (code) => console.log(`VAD process exited with code ${code}`));
    }

    processAudio(audioData) {
        if (this.ffmpeg && this.ffmpeg.stdin.writable) {
            this.ffmpeg.stdin.write(audioData);
        }
    }

    cleanup() {
        if (this.ffmpeg) {
            this.ffmpeg.stdin.end();
            this.ffmpeg.kill();
        }
        if (this.vad) {
            this.vad.kill();
        }
    }
}

module.exports = new AudioProcessor(); 