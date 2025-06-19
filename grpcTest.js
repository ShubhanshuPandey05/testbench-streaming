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

// Test cases: last message is always from 'user'
const testCases = [
  {
    messages: [
      { role: 'assistant', content: 'Hello! How can I help you today?' },
      { role: 'user', content: 'I’m checking the status of my order.' },
      { role: 'assistant', content: 'Sure, can you give me the order number?' },
      { role: 'user', content: '#12345, placed yesterday.' },
      { role: 'assistant', content: 'Got it. Your order is on the way.' },
      { role: 'user', content: 'Alright, thanks!' },
      { role: 'assistant', content: 'Would you like to place another order?' },
      { role: 'user', content: 'No thanks, I just wanted to track my last one.' }
    ],
    expected: true
  },
  {
    messages: [
      { role: 'assistant', content: 'Hi! Need help with anything?' },
      { role: 'user', content: 'I’m just exploring right now.' },
      { role: 'assistant', content: 'Sure, let me know if you need anything.' },
      { role: 'user', content: 'Thanks, I might.' },
      { role: 'assistant', content: 'What can I help you with today?' },
      { role: 'user', content: 'I’m wondering about something.' },
      { role: 'assistant', content: 'Go ahead.' },
      { role: 'user', content: 'I was wondering if you could maybe' }
    ],
    expected: false
  },
  {
    messages: [
      { role: 'assistant', content: 'Welcome! What do you need?' },
      { role: 'user', content: 'I bought something last week.' },
      { role: 'assistant', content: 'Would you like a refund or an exchange?' },
      { role: 'user', content: 'I think I want a refund.' },
      { role: 'assistant', content: 'Sure, initiating the refund now.' },
      { role: 'user', content: 'Thanks for the quick response.' },
      { role: 'assistant', content: 'Is there anything else I can do?' },
      { role: 'user', content: 'No, that’s all for now.' }
    ],
    expected: true
  },
  {
    messages: [
      { role: 'assistant', content: 'Is your issue resolved now?' },
      { role: 'user', content: 'Mostly, yes.' },
      { role: 'assistant', content: 'Glad to hear it!' },
      { role: 'user', content: 'But actually, I still need help.' },
      { role: 'assistant', content: 'Sure, what else?' },
      { role: 'user', content: 'Let me think.' },
      { role: 'assistant', content: 'Is your issue resolved now?' },
      { role: 'user', content: 'Actually, one more thing I wanted to ask' }
    ],
    expected: false
  },
  {
    messages: [
      { role: 'assistant', content: 'Hello! How can I assist you today?' },
      { role: 'user', content: 'I have a query about my payment.' },
      { role: 'assistant', content: 'Sure, go ahead.' },
      { role: 'user', content: 'Was my last payment successful?' },
      { role: 'assistant', content: 'Let me check that for you.' },
      { role: 'user', content: 'Thanks, take your time.' },
      { role: 'assistant', content: 'Anything else you need?' },
      { role: 'user', content: 'Yes, please also check if my last payment was successful.' }
    ],
    expected: true
  },
  {
    messages: [
      { role: 'assistant', content: 'How can I help you?' },
      { role: 'user', content: 'Hold on, finding some info first.' },
      { role: 'assistant', content: 'No problem.' },
      { role: 'user', content: 'I think I have it now.' },
      { role: 'assistant', content: 'Please share the details.' },
      { role: 'user', content: 'Just a sec.' },
      { role: 'assistant', content: 'How can I assist you today?' },
      { role: 'user', content: 'Just a sec, I’m trying to find the order number' }
    ],
    expected: false
  },
  {
    messages: [
      { role: 'assistant', content: 'Welcome!' },
      { role: 'user', content: 'Hey there!' },
      { role: 'assistant', content: 'How can I help today?' },
      { role: 'user', content: 'What are my appointments?' },
      { role: 'assistant', content: 'Let me check your calendar.' },
      { role: 'user', content: 'Thanks.' },
      { role: 'assistant', content: 'Welcome!' },
      { role: 'user', content: 'Hey, can you show me my upcoming appointments?' }
    ],
    expected: true
  },
  {
    messages: [
      { role: 'assistant', content: 'How can I assist with your order?' },
      { role: 'user', content: 'It’s not been delivered yet.' },
      { role: 'assistant', content: 'Let me check your tracking status.' },
      { role: 'user', content: 'Thanks, please do.' },
      { role: 'assistant', content: 'Tracking says it’s in transit.' },
      { role: 'user', content: 'That’s weird.' },
      { role: 'assistant', content: 'What’s the issue with your order?' },
      { role: 'user', content: 'It never arrived and the tracking still says' }
    ],
    expected: false
  },
  {
    messages: [
      { role: 'assistant', content: 'Can I know what you ordered?' },
      { role: 'user', content: 'Yes, the noise-cancelling headphones.' },
      { role: 'assistant', content: 'Great choice!' },
      { role: 'user', content: 'Thanks.' },
      { role: 'assistant', content: 'When did you place the order?' },
      { role: 'user', content: 'Last Friday.' },
      { role: 'assistant', content: 'What product did you order?' },
      { role: 'user', content: 'The noise-cancelling headphones.' }
    ],
    expected: true
  },
  {
    messages: [
      { role: 'assistant', content: 'Tell me what happened.' },
      { role: 'user', content: 'I received the wrong item.' },
      { role: 'assistant', content: 'Sorry to hear that!' },
      { role: 'user', content: 'It’s not a huge issue, but I need the correct one.' },
      { role: 'assistant', content: 'We’ll get that fixed.' },
      { role: 'user', content: 'Thanks.' },
      { role: 'assistant', content: 'Go on…' },
      { role: 'user', content: 'So I received the wrong item in the package and I want to' }
    ],
    expected: false
  },
  {
    messages: [
      { role: 'assistant', content: 'Do you need help with scheduling?' },
      { role: 'user', content: 'Yes, I need to schedule something.' },
      { role: 'assistant', content: 'What time works for you?' },
      { role: 'user', content: 'Tomorrow at 10 AM.' },
      { role: 'assistant', content: 'Got it.' },
      { role: 'user', content: 'Thanks.' },
      { role: 'assistant', content: 'Do you want me to schedule a meeting?' },
      { role: 'user', content: 'Yes, schedule it for tomorrow at 10 AM.' }
    ],
    expected: true
  },
  {
    messages: [
      { role: 'assistant', content: 'What’s your address?' },
      { role: 'user', content: 'I’ve added a new one.' },
      { role: 'assistant', content: 'Should I use that one?' },
      { role: 'user', content: 'Yes.' },
      { role: 'assistant', content: 'Okay, updated.' },
      { role: 'user', content: 'Great.' },
      { role: 'assistant', content: 'What address should I use for delivery?' },
      { role: 'user', content: 'Use the new address I added yesterday, the one near' }
    ],
    expected: false
  }
  // ... continue with remaining test cases using same structure
];


// Delay helper
const sleep = ms => new Promise(res => setTimeout(res, ms));

// Run tests
async function runTests() {
  let res = 0;
  for (let i = 0; i < testCases.length; i++) {
    const { messages, expected } = testCases[i];


    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role !== 'user') {
      console.warn(`❌ Test ${i + 1} skipped: Last message not from user`);
      continue;
    }

    client.CheckEndOfTurn({ messages }, (err, response) => {
      console.log(res)
      if (err) {
        console.error(`❌ [${i + 1}] gRPC Error:`, err.message);
      } else {
        if (expected == response.end_of_turn) {
          res = res+1
        }
        console.log(
          `${expected == response.end_of_turn ? '✅' : '❌'} [${i + 1}] End of Turn: ${response.end_of_turn} | Expected: ${expected} | Message: "${lastMessage.content}"`
        );
      }
    });

    // console.log(res)
    await sleep(10); // Delay between calls
  }
  // console.log(res)
}

runTests();