import { useEffect, useRef, useState } from 'react';
import './App.css';

const App = () => {
  const [recording, setRecording] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [sessionId, setSessionId] = useState(null);
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
  const audioQueueRef = useRef([]);
  const isPlayingRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const lastInterimTimeRef = useRef(0);
  const INTERIM_THRESHOLD = 500;
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [latency, setLatency] = useState({
    llm: 0,
    stt: 0,
    tts: 0
  });

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
    if (wsRef.current && sessionId) {
      // Send stop session message before closing
      wsRef.current.send(JSON.stringify({
        type: 'stop_session',
        sessionId: sessionId
      }));
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

  const playNextAudio = async () => {
    if (audioQueueRef.current.length === 0 || isPlayingRef.current) {
      return;
    }

    isPlayingRef.current = true;
    const { audioData, isInterim } = audioQueueRef.current.shift();

    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }

      const audioBuffer = await audioContextRef.current.decodeAudioData(audioData);
      const source = audioContextRef.current.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContextRef.current.destination);

      source.onended = () => {
        isPlayingRef.current = false;
        setIsPlaying(false);
        playNextAudio();
      };

      setIsPlaying(true);
      source.start(0);
    } catch (err) {
      console.error('Error playing audio:', err);
      isPlayingRef.current = false;
      setIsPlaying(false);
      playNextAudio();
    }
  };

  const queueAudio = (audioData, isInterim) => {
    const now = Date.now();

    // For interim results, check if enough time has passed since last interim
    if (isInterim && now - lastInterimTimeRef.current < INTERIM_THRESHOLD) {
      return;
    }

    if (isInterim) {
      lastInterimTimeRef.current = now;
    }

    audioQueueRef.current.push({ audioData, isInterim });
    if (!isPlayingRef.current) {
      playNextAudio();
    }
  };

  const handleChatSubmit = (e) => {
    e.preventDefault();
    if (!chatInput.trim() || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    setChatMessages(prev => [...prev, { role: 'user', content: chatInput }]);
    console.log('Sending chat message:', chatInput);
    
    wsRef.current.send(JSON.stringify({
      type: 'chat',
      message: chatInput
    }));
    setChatInput('');
  };

  const handleChatInput = (e) => {
    setChatInput(e.target.value);
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

      // Connect to WebSocket
      wsRef.current = new WebSocket('ws://localhost:5001');
      let reconnectTimeout = null;

      wsRef.current.onopen = () => {
        console.log('WebSocket connected, starting session...');
        
        // Initialize session with the server
        wsRef.current.send(JSON.stringify({
          type: 'start_session'
        }));
      };

      wsRef.current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('Received message:', data);

          if (data.type === 'session_started') {
            // Session initialized successfully
            setSessionId(data.sessionId);
            setIsConnected(true);
            console.log('Session started with ID:', data.sessionId);

            // Now start recording
            mediaRecorderRef.current = new MediaRecorder(stream, {
              mimeType: 'audio/webm;codecs=opus',
            });

            mediaRecorderRef.current.ondataavailable = (e) => {
              if (e.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(e.data);
              }
            };

            mediaRecorderRef.current.start(50);
            setRecording(true);

          } else if (data.type === 'audio') {
            // Convert base64 to ArrayBuffer
            const binaryString = window.atob(data.audio);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }

            // Queue the audio with its type (interim or final)
            queueAudio(bytes.buffer, !data.isFinal);
            
            if (data.latency) {
              console.log('Latency:', data.latency);
              setLatency({
                llm: data.latency.llm || 0,
                stt: data.latency.stt || 0,
                tts: data.latency.tts || 0
              });
            }

          } else if (data.type === 'tts_error') {
            console.error('TTS Error:', data.error);
            setError('TTS Error: ' + data.error);

          } else if (data.transcript) {
            if (data.isInterim) {
              setInterimTranscript(data.transcript);
            } else {
              setTranscript(prev => prev + ' ' + data.transcript);
              setInterimTranscript('');
            }

          } else if (data.type === 'text' || data.type === 'text_response') {
            console.log('Text response:', data.text);
            setChatMessages(prev => [...prev, { role: 'assistant', content: data.text }]);

          } else if (data.error) {
            setError(data.error);
            console.error('Server error:', data.error);
          }

        } catch (err) {
          console.error('Error parsing WebSocket message:', err);
          setError('Error parsing server response');
        }
      };

      wsRef.current.onerror = (error) => {
        setError('WebSocket connection error');
        console.error('WebSocket error:', error);
      };

      wsRef.current.onclose = (event) => {
        console.log('WebSocket closed:', event.code, event.reason);
        setIsConnected(false);
        setSessionId(null);
        
        if (recording && !event.wasClean) {
          // Attempt to reconnect after 2 seconds if connection was lost unexpectedly
          reconnectTimeout = setTimeout(() => {
            if (recording) {
              console.log('Attempting to reconnect...');
              startRecording();
            }
          }, 2000);
        }
      };

    } catch (err) {
      setError('Failed to access microphone: ' + err.message);
      console.error('Error accessing microphone:', err);
    }
  };

  const stopRecording = () => {
    cleanup();
    setRecording(false);
    setIsConnected(false);
    setSessionId(null);
    setAudioLevel(0);
    setInterimTranscript('');
  };

  const clearTranscript = () => {
    setTranscript('');
    setInterimTranscript('');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 to-gray-800 text-white p-6">
      {/* Header */}
      <header className="mb-6 text-center">
        <h1 className="text-3xl font-extrabold tracking-wide">🎙️ Voice Agent Dashboard</h1>
        <p className="text-sm text-gray-400 mt-1">Monitor, Record & Interact</p>
        {sessionId && (
          <p className="text-xs text-blue-400 mt-1">Session: {sessionId}</p>
        )}
      </header>

      {/* Status Card */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        <div className="bg-white/10 backdrop-blur-md p-4 rounded-xl border border-white/20 shadow-md">
          <p className="text-sm text-gray-300">Connection</p>
          <div className={`mt-1 text-lg font-bold ${isConnected ? 'text-green-400' : 'text-red-400'}`}>
            {isConnected ? 'Connected' : 'Disconnected'}
          </div>
          {error && <div className="mt-2 text-red-300 text-sm">{error}</div>}
          {isPlaying && <div className="mt-2 text-blue-300 text-sm">Playing back...</div>}
        </div>

        <div className="bg-white/10 backdrop-blur-md p-4 rounded-xl border border-white/20 shadow-md">
          <p className="text-sm text-gray-300 mb-1">Audio Level</p>
          <div className="w-full bg-gray-600 h-3 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${recording ? 'bg-green-500' : 'bg-gray-300'}`}
              style={{ width: `${audioLevel}%` }}
            ></div>
          </div>
        </div>

        <div className="bg-white/10 backdrop-blur-md p-4 rounded-xl border border-white/20 shadow-md">
          <p className="text-sm text-gray-300">Latency (ms)</p>
          <div className="mt-2 space-y-1">
            <p><span className="text-gray-400">LLM:</span> {latency.llm}</p>
            <p><span className="text-gray-400">STT:</span> {latency.stt}</p>
            <p><span className="text-gray-400">TTS:</span> {latency.tts}</p>
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-4 mb-6 justify-center">
        {recording ? (
          <button
            onClick={stopRecording}
            className="bg-red-600 hover:bg-red-700 transition px-6 py-2 rounded-full font-semibold shadow"
          >
            ⏹ Stop Recording
          </button>
        ) : (
          <button
            onClick={startRecording}
            className="bg-green-600 hover:bg-green-700 transition px-6 py-2 rounded-full font-semibold shadow"
          >
            🎙️ Start Recording
          </button>
        )}
        <button
          onClick={clearTranscript}
          className="bg-yellow-600 hover:bg-yellow-700 transition px-6 py-2 rounded-full font-semibold shadow"
        >
          🧹 Clear Transcript
        </button>
      </div>

      {/* Transcript */}
      <div className="bg-white/10 backdrop-blur-md p-6 rounded-xl border border-white/20 shadow-md mb-6">
        <h2 className="text-2xl font-bold mb-2">📝 Transcript</h2>
        <div className="text-gray-200 whitespace-pre-wrap break-words h-40 overflow-y-auto">
          {transcript}
          {interimTranscript && (
            <span className="italic text-gray-400">{interimTranscript}</span>
          )}
          <div ref={transcriptEndRef} />
        </div>
      </div>

      {/* Chat Section */}
      <div className="bg-white/10 backdrop-blur-md p-6 rounded-xl border border-white/20 shadow-md">
        <h2 className="text-2xl font-bold mb-4">💬 Chat</h2>
        <div className="h-40 bg-white/5 rounded-lg overflow-y-auto p-3 mb-4 text-sm text-gray-200 border border-white/10">
          {chatMessages.map((msg, index) => (
            <div key={index} className={`mb-2 ${msg.role === 'user' ? 'text-blue-300' : 'text-green-300'}`}>
              <strong>{msg.role === 'user' ? 'You' : 'Assistant'}:</strong> {msg.content}
            </div>
          ))}
        </div>
        <form onSubmit={handleChatSubmit} className="flex gap-2">
          <input
            type="text"
            placeholder="Type your message..."
            value={chatInput}
            onChange={handleChatInput}
            disabled={!isConnected}
            className="flex-1 bg-white/10 text-white placeholder-gray-400 px-4 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!isConnected || !chatInput.trim()}
            className="bg-blue-600 hover:bg-blue-700 transition px-5 py-2 rounded-lg font-semibold shadow disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
};

export default App;