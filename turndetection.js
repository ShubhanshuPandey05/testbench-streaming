// function isTurnComplete(
//   text,
//   minLength = 3,
//   maxLength = 50,
//   incompleteEndings = [
//     'and', 'but', 'or', 'so', 'because', 'although', 'though', 'if', 'when', 'while', 'since', 'unless'
//   ],
//   incompletePhrases = [
//     'you know', 'i mean', 'for example', 'such as', 'like i said'
//   ]
// ) {
//   if (!text || typeof text !== 'string') return false;
//   text = text.trim();
//   if (!text) return false;

//   // Check for ellipsis or unfinished punctuation
//   if (text.endsWith('...') || text.endsWith('--') || text.endsWith('-')) {
//     return false;
//   }

//   // Check for strong ending punctuation
//   if (/[.?!]$/.test(text)) {
//     return true;
//   }

//   // Check for incomplete ending words
//   const words = text.split(/\s+/);
//   const lastWord = words[words.length - 1].toLowerCase();
//   if (incompleteEndings.includes(lastWord)) {
//     return false;
//   }

//   // Check for incomplete phrases at the end
//   const lowered = text.toLowerCase();
//   for (const phrase of incompletePhrases) {
//     if (lowered.endsWith(phrase)) {
//       return false;
//     }
//   }

//   // Check for minimum and maximum length
//   if (words.length < minLength) return false;
//   if (words.length > maxLength) return false;

//   // Check for common unfinished patterns
//   const unfinishedPatterns = [
//     /(i was going to|let me just|i think i|maybe we should|i just wanted to)$/i
//   ];
//   for (const pattern of unfinishedPatterns) {
//     if (pattern.test(lowered)) {
//       return false;
//     }
//   }

//   // Default: treat as complete
//   return true;
// }

// // Example usage:
// const examples = [
//   "I was thinking about it and",
//   "Let me just",
//   "How are you?",
//   "I mean",
//   "The results are in.",
//   "Because",
//   "I just wanted to",
//   "That's all--",
//   "Yes!",
//   "No",
//   "Sure.",
//   "For example",
//   "I think I",
//   "Want to become a hero like"
// ];

// examples.forEach(ex => {
//   console.log(`'${ex}' -> ${isTurnComplete(ex)}`);
// });



// const { pipeline, AutoTokenizer } = require('@huggingface/transformers');

// async function main() {
//   const tokenizer = await AutoTokenizer.from_pretrained('livekit/turn-detector');
//   const messages = [
//     { role: 'user', content: 'Who are you?' },
//     { role: 'assistant', content: 'I am John.' },
//     { role: 'user', content: 'What is your last name?' },
//     { role: 'assistant', content: 'Smith.' },
//     { role: 'user', content: 'How do you spell the first' }
//   ];
//   const text = tokenizer.apply_chat_template(messages, {
//     add_generation_prompt: false,
//     add_special_tokens: false,
//     tokenize: false
//   });
//   const classifier = await pipeline('text-classification', 'livekit/turn-detector');
//   const output = await classifier(text);
//   const eouProbability = output[0].score; // Assuming index 1 is EOU class
//   console.log(`End of utterance probability: ${eouProbability}`);
// }

// main();






const { pipeline } = require('@huggingface/transformers');

// Cache pipeline for instant inference
let classifier = null;

async function initClassifier() {
  if (!classifier) {
    classifier = await pipeline('text-classification', './distilbert-turn-detection');
  }
  return classifier;
}

async function runTurnDetection(messages) {
  try {
    // Initialize classifier
    await initClassifier();

    // Format conversation (concatenate messages)
    const text = messages.map(m => `${m.role}: ${m.content}`).join('\n');

    // Run inference
    const output = await classifier(text);

    // Map output to turn detection (end vs. not_end)
    const eouProbability = output[0].label === 'end' ? output[0].score : 1 - output[0].score;

    return {
      output: `End of utterance probability: ${eouProbability}`,
      outputType: 'text'
    };
  } catch (error) {
    return {
      output: `Error: ${error.message}`,
      outputType: 'text'
    };
  }
}

const messages = [
  { role: 'system', content: 'You are a helpful assistant. Always reply in JSON with two keys: "output" and "outputType".' },
  { role: 'user', content: 'Hello.' }
];

runTurnDetection(messages).then(console.log);