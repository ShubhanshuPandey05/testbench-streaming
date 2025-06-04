const fs = require('fs');
const wav = require('node-wav');

const buffer = `<Buffer 42 08 af 0b 5c 18 a7 2a 0a 31 c5 31 80 31 66 30 2e 2a c1 23 a9 1c 47 1f dc 24 59 28 68 2b 8f 2d 98 2b f9 25 e3 15 fd 08 98 07 f5 0b 59 0d 1d 0a 8e 04 ... 15950 more bytes>`; // your PCM buffer
const wavBuffer = wav.encode([new Int16Array(buffer.buffer)], {
    sampleRate: 16000,
    float: false,
    bitDepth: 16,
});

fs.writeFileSync('output.wav', wavBuffer);