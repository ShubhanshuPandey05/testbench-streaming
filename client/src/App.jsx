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
  const audioQueueRef = useRef([]);
  const isPlayingRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const lastInterimTimeRef = useRef(0);
  const INTERIM_THRESHOLD = 500;
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  // const [isChatActive, setIsChatActive] = useState(false);
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
    setChatMessages([...chatMessages, { role: 'user', content: chatInput }]);
    console.log('Sending chat message:', chatInput);
    // console.log(wsRef.current);
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

      // wsRef.current = new WebSocket('wss://a31a-2401-4900-1c80-9450-6c61-8e74-1d49-209a.ngrok-free.app');
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

        mediaRecorderRef.current.start(50);
        setRecording(true);
      };

      wsRef.current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'audio') {
            // Convert base64 to ArrayBuffer
            const binaryString = window.atob(data.audio);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }

            // Queue the audio with its type (interim or final)
            queueAudio(bytes.buffer, data.isFinal);
            console.log('latency', data.latency);
            setLatency({
              llm: data.latency.llm,
              stt: data.latency.stt,
              tts: data.latency.tts
            });
          } else if (data.type === 'tts_error') {
            console.error('TTS Error:', data.error);
          } else if (data.transcript) {
            if (data.isInterim) {
              setInterimTranscript(data.transcript);
            } else {
              setTranscript(prev => prev + ' ' + data.transcript);
              setInterimTranscript('');
            }
          } else if (data.type === 'text') {
            console.log('text', data.text);
            setChatMessages(prev => [...prev, { role: 'assistant', content: data.text }]);
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
  // const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  // let audioQueue = [];
  // let playing = false;

  // // const ws = new WebSocket('ws://localhost:5001');
  // wsRef.binaryType = 'arraybuffer';

  // wsRef.current.onmessage = async (event) => {
  //   if (typeof event.data === 'string') {
  //     const msg = JSON.parse(event.data);
  //     if (msg.type === 'end') return; // End of stream
  //   } else {
  //     audioQueue.push(event.data);
  //     if (!playing) playNextChunk();
  //   }
  // };

  // async function playNextChunk() {
  //   if (audioQueue.length === 0) {
  //     playing = false;
  //     return;
  //   }
  //   playing = true;
  //   const chunk = audioQueue.shift();
  //   const audioBuffer = await audioContext.decodeAudioData(chunk);
  //   const source = audioContext.createBufferSource();
  //   source.buffer = audioBuffer;
  //   source.connect(audioContext.destination);
  //   source.onended = playNextChunk;
  //   source.start();
  // }



  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 to-gray-800 text-white p-6">

      {/* Header */}
      <header className="mb-6 text-center">
        <h1 className="text-3xl font-extrabold tracking-wide">🎙️ Voice Agent Dashboard</h1>
        <p className="text-sm text-gray-400 mt-1">Monitor, Record & Interact</p>
      </header>

      {/* Status Card */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        <div className="bg-white/10 backdrop-blur-md p-4 rounded-xl border border-white/20 shadow-md">
          <p className="text-sm text-gray-300">Connection</p>
          <div className={`mt-1 text-lg font-bold ${isConnected ? 'text-green-400' : 'text-red-400'
            }`}>
            {isConnected ? 'Connected' : 'Disconnected'}
          </div>
          {error && <div className="mt-2 text-red-300 text-sm">{error}</div>}
          {isPlaying && <div className="mt-2 text-blue-300 text-sm">Playing back...</div>}
        </div>

        <div className="bg-white/10 backdrop-blur-md p-4 rounded-xl border border-white/20 shadow-md">
          <p className="text-sm text-gray-300 mb-1">Audio Level</p>
          <div className="w-full bg-gray-600 h-3 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${recording ? 'bg-green-500' : 'bg-gray-300'
                }`}
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
          <div className="chat-messages"></div>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Type your message..."
            value={chatInput}
            onChange={handleChatInput}
            className="flex-1 bg-white/10 text-white placeholder-gray-400 px-4 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
          <button
            onClick={handleChatSubmit}
            className="bg-blue-600 hover:bg-blue-700 transition px-5 py-2 rounded-lg font-semibold shadow"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );


};

export default App;