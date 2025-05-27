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
    <div className="app-container">
      <div className="status-bar">
        <div className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
          {isConnected ? 'Connected' : 'Disconnected'}
        </div>
        {error && <div className="error-message">{error}</div>}
        {isPlaying && <div className="playing-status">Playing back...</div>}
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

      <div className="latency-container">
        <h2>Latency</h2>
        <div className="latency">
          <p>LLM: {latency.llm}ms</p>
          <p>STT: {latency.stt}ms</p>
          <p>TTS: {latency.tts}ms</p>
        </div>
      </div>

      <div>
        <h2>Chat</h2>
        <div className="chat-container">
          <div className="chat-messages"></div>
        </div>
        <div className="chat-input">
          <input type="text" placeholder="Message" value={chatInput} onChange={handleChatInput} />
          <button onClick={handleChatSubmit}>Send</button>
        </div>
      </div>
    </div>
  );
};

export default App;