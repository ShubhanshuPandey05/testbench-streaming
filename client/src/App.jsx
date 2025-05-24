import { useEffect, useRef, useState } from 'react';

const App = () => {
  const [recording, setRecording] = useState(false);
  const wsRef = useRef(null);
  const mediaRecorderRef = useRef(null);

  const startRecording = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    wsRef.current = new WebSocket('ws://localhost:5001');

    wsRef.current.onopen = () => {
      mediaRecorderRef.current = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus',
      });

      mediaRecorderRef.current.ondataavailable = (e) => {
        if (e.data.size > 0 && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(e.data);
        }
      };

      mediaRecorderRef.current.start(100); // send audio every 250ms
      setRecording(true);
    };
  };

  const stopRecording = () => {
    mediaRecorderRef.current.stop();
    wsRef.current.close();
    setRecording(false);
  };

  return (
    <div>
      {recording ? (
        <button onClick={stopRecording}>Stop</button>
      ) : (
        <button onClick={startRecording}>Start</button>
      )}
    </div>
  );
};

export default App;