// grpcTest.js
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const PROTO_PATH = './turn.proto';

// Load proto file
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const turnProto = grpc.loadPackageDefinition(packageDefinition).turn;

// Create gRPC client
const client = new turnProto.TurnDetector(
  'localhost:50051',
  grpc.credentials.createInsecure()
);

// Define test message
const chatHistory = [
  { role: 'assistant', content: 'You are a helpful assistant' },
  { role: 'user', content: 'Can you help me in this project.' }
];

// Call the gRPC service
client.CheckEndOfTurn({ messages: chatHistory }, (err, response) => {
    console.log(response)
  if (err) {
    console.error('❌ gRPC Error:', err);
  } else {
    console.log('✅ End of Turn:', response.end_of_turn);
  }
});