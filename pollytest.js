const express = require("express");
const { PollyClient, SynthesizeSpeechCommand } = require("@aws-sdk/client-polly");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const port = 3000;

const polly = new PollyClient({
    region: "us-east-1",
    credentials: {
        accessKeyId: `${process.env.accessKeyId}`,
        secretAccessKey: `${process.env.secretAccessKey}`,
    },
});

app.get("/speech", async (req, res) => {
    const params = {
        OutputFormat: "mp3",
        Text: `Shubhanshu`,
        VoiceId: "Joanna",
    };

    try {
        const command = new SynthesizeSpeechCommand(params);
        const data = await polly.send(command);

        if (data.AudioStream) {
            res.set({
                "Content-Type": "audio/mpeg",
                "Transfer-Encoding": "chunked",
            });

            const audioBuffer = Buffer.from(await data.AudioStream.transformToByteArray());
            console.log(audioBuffer);
            res.send(audioBuffer);
        } else {
            res.status(500).send("AudioStream not found in the response.");
        }
    } catch (err) {
        console.error("Error synthesizing speech:", err);
        res.status(500).send("Error synthesizing speech");
    }
});

app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});