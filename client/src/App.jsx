import { useEffect, useRef, useState } from 'react';
import './App.css';

const App = () => {
  const [recording, setRecording] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const wsRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const animationFrameRef = useRef(null);
  const transcriptEndRef = useRef(null);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, []);

  // Auto-scroll transcript to bottom
  useEffect(() => {
    if (transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcript, interimTranscript]);

  const cleanup = () => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
    }
  };

  const setupAudioAnalysis = (stream) => {
    audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
    analyserRef.current = audioContextRef.current.createAnalyser();
    const source = audioContextRef.current.createMediaStreamSource(stream);
    source.connect(analyserRef.current);
    analyserRef.current.fftSize = 256;
    
    const updateAudioLevel = () => {
      const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
      analyserRef.current.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
      setAudioLevel(average);
      animationFrameRef.current = requestAnimationFrame(updateAudioLevel);
    };
    
    updateAudioLevel();
  };

  const startRecording = async () => {
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        } 
      });
      setupAudioAnalysis(stream);
      
      wsRef.current = new WebSocket('ws://localhost:5001');
      let reconnectTimeout = null;

      wsRef.current.onopen = () => {
        setIsConnected(true);
        mediaRecorderRef.current = new MediaRecorder(stream, {
          mimeType: 'audio/webm;codecs=opus',
        });

        mediaRecorderRef.current.ondataavailable = (e) => {
          if (e.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(e.data);
          }
        };

        mediaRecorderRef.current.start(100);
        setRecording(true);
      };

      wsRef.current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.transcript) {
            if (data.isInterim) {
              setInterimTranscript(data.transcript);
            } else {
              setTranscript(prev => prev + ' ' + data.transcript);
              setInterimTranscript('');
            }
          } else if (data.error) {
            setError(data.error);
          }
        } catch (err) {
          console.error('Error parsing WebSocket message:', err);
        }
      };

      wsRef.current.onerror = (error) => {
        setError('WebSocket error occurred');
        console.error('WebSocket error:', error);
      };

      wsRef.current.onclose = () => {
        setIsConnected(false);
        if (recording) {
          // Attempt to reconnect after 2 seconds
          reconnectTimeout = setTimeout(() => {
            if (recording) {
              startRecording();
            }
          }, 2000);
        }
      };

    } catch (err) {
      setError('Failed to access microphone');
      console.error('Error accessing microphone:', err);
    }
  };

  const stopRecording = () => {
    cleanup();
    setRecording(false);
    setIsConnected(false);
    setAudioLevel(0);
    setInterimTranscript('');
  };

  const clearTranscript = () => {
    setTranscript('');
    setInterimTranscript('');
  };

  return (
    <div className="app-container">
      <div className="status-bar">
        <div className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
          {isConnected ? 'Connected' : 'Disconnected'}
        </div>
        {error && <div className="error-message">{error}</div>}
      </div>

      <div className="audio-visualizer">
        <div 
          className="audio-level" 
          style={{ 
            width: `${audioLevel}%`,
            backgroundColor: recording ? '#4CAF50' : '#9e9e9e'
          }}
        />
      </div>

      <div className="controls">
        {recording ? (
          <button className="stop-button" onClick={stopRecording}>
            Stop Recording
          </button>
        ) : (
          <button className="start-button" onClick={startRecording}>
            Start Recording
          </button>
        )}
        <button className="clear-button" onClick={clearTranscript}>
          Clear Transcript
        </button>
      </div>

      <div className="transcript-container">
        <h2>Transcript</h2>
        <div className="transcript">
          {transcript}
          {interimTranscript && (
            <span className="interim-text">{interimTranscript}</span>
          )}
          <div ref={transcriptEndRef} />
        </div>
      </div>
    </div>
  );
};

export default App;