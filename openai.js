const OpenAI = require("openai");
require('dotenv').config();
const client = new OpenAI({ apiKey: process.env.OPEN_AI });

async function generateStory() {
    const response = await client.responses.create({
        model: "gpt-4o-mini",
        input: 'Write a ten-sentence bedtime story about a unicorn.'
    });
    console.log(response.output_text);


    // const stream = await client.responses.create({
    //     model: "gpt-4o-mini",
    //     input: [
    //         {
    //             role: "user",
    //             content: "Hello",
    //         },
    //     ],
    //     stream: true,
    // });

    // for await (const event of stream) {
    //     console.log(event);
    // }

}

generateStory();