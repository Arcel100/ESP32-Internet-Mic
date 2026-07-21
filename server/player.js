"use strict";

/*
 * ESP32 Internet Mic - Browser Audio Player
 *
 * Receives:
 *   Signed 16-bit little-endian PCM
 *   Mono
 *   16,000 Hz
 *
 * Audio path:
 *   WebSocket -> resampler -> AudioWorklet -> speakers
 */

const SOURCE_SAMPLE_RATE = 16000;
const RECONNECT_DELAY_MS = 2000;
const START_BUFFER_SECONDS = 0.12;
const MAX_BUFFER_SECONDS = 1.5;

const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const connectionStatus = document.getElementById("connectionStatus");
const microphoneStatus = document.getElementById("microphoneStatus");
const listenerCount = document.getElementById("listenerCount");
const audioLevel = document.getElementById("audioLevel");
const levelText = document.getElementById("levelText");

let audioContext = null;
let workletNode = null;
let webSocket = null;
let resampler = null;

let shouldReconnect = false;
let reconnectTimer = null;
let microphoneConnected = false;


/* ---------------------------------------------------------
   Streaming sample-rate converter
--------------------------------------------------------- */

class StreamingResampler {
    constructor(inputRate, outputRate) {
        this.inputRate = inputRate;
        this.outputRate = outputRate;

        // Distance through the source audio for each output sample.
        this.step = inputRate / outputRate;

        this.position = 0;
        this.previousSample = 0;
        this.hasPreviousSample = false;
    }

    reset() {
        this.position = 0;
        this.previousSample = 0;
        this.hasPreviousSample = false;
    }

    process(inputSamples) {
        if (inputSamples.length === 0) {
            return new Float32Array(0);
        }

        let source;

        if (this.hasPreviousSample) {
            source = new Float32Array(inputSamples.length + 1);
            source[0] = this.previousSample;
            source.set(inputSamples, 1);
        } else {
            source = inputSamples;
            this.hasPreviousSample = true;
        }

        if (source.length < 2) {
            this.previousSample = source[source.length - 1];
            return new Float32Array(0);
        }

        const estimatedLength = Math.ceil(
            (source.length - 1 - this.position) / this.step
        );

        const output = new Float32Array(
            Math.max(0, estimatedLength)
        );

        let outputIndex = 0;

        while (
            this.position < source.length - 1 &&
            outputIndex < output.length
        ) {
            const leftIndex = Math.floor(this.position);
            const rightIndex = leftIndex + 1;
            const fraction = this.position - leftIndex;

            const leftSample = source[leftIndex];
            const rightSample = source[rightIndex];

            output[outputIndex] =
                leftSample +
                (rightSample - leftSample) * fraction;

            outputIndex += 1;
            this.position += this.step;
        }

        // Preserve fractional position for the next packet.
        this.position -= source.length - 1;
        this.previousSample = source[source.length - 1];

        if (outputIndex === output.length) {
            return output;
        }

        return output.slice(0, outputIndex);
    }
}


/* ---------------------------------------------------------
   AudioWorklet source
--------------------------------------------------------- */

const workletSource = `
class PCMStreamProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        this.queue = [];
        this.queueOffset = 0;
        this.bufferedSamples = 0;

        this.started = false;

        const processorOptions =
            options.processorOptions || {};

        this.startBufferSamples =
            processorOptions.startBufferSamples || 4096;

        this.maxBufferSamples =
            processorOptions.maxBufferSamples || 72000;

        this.port.onmessage = (event) => {
            const message = event.data;

            if (!message || !message.type) {
                return;
            }

            if (message.type === "audio") {
                const samples = message.samples;

                if (
                    samples instanceof Float32Array &&
                    samples.length > 0
                ) {
                    this.queue.push(samples);
                    this.bufferedSamples += samples.length;

                    this.trimOldAudio();

                    if (
                        !this.started &&
                        this.bufferedSamples >=
                            this.startBufferSamples
                    ) {
                        this.started = true;

                        this.port.postMessage({
                            type: "playback-started"
                        });
                    }
                }
            }

            if (message.type === "clear") {
                this.queue = [];
                this.queueOffset = 0;
                this.bufferedSamples = 0;
                this.started = false;
            }
        };
    }

    trimOldAudio() {
        while (
            this.bufferedSamples >
                this.maxBufferSamples &&
            this.queue.length > 0
        ) {
            const first = this.queue[0];
            const remaining =
                first.length - this.queueOffset;

            this.bufferedSamples -= remaining;
            this.queue.shift();
            this.queueOffset = 0;
        }
    }

    readSample() {
        while (this.queue.length > 0) {
            const first = this.queue[0];

            if (this.queueOffset < first.length) {
                const sample =
                    first[this.queueOffset];

                this.queueOffset += 1;
                this.bufferedSamples -= 1;

                if (this.queueOffset >= first.length) {
                    this.queue.shift();
                    this.queueOffset = 0;
                }

                return sample;
            }

            this.queue.shift();
            this.queueOffset = 0;
        }

        return 0;
    }

    process(inputs, outputs) {
        const output = outputs[0];
        const channel = output[0];

        if (!channel) {
            return true;
        }

        if (!this.started) {
            channel.fill(0);
            return true;
        }

        for (
            let index = 0;
            index < channel.length;
            index += 1
        ) {
            channel[index] = this.readSample();
        }

        if (this.bufferedSamples <= 0) {
            this.started = false;

            this.port.postMessage({
                type: "buffer-underrun"
            });
        }

        return true;
    }
}

registerProcessor(
    "pcm-stream-processor",
    PCMStreamProcessor
);
`;


/* ---------------------------------------------------------
   UI helpers
--------------------------------------------------------- */

function setConnectionStatus(text, state) {
    connectionStatus.textContent = text;
    connectionStatus.dataset.state = state;
}

function updateMicrophoneStatus(connected) {
    microphoneConnected = connected;

    microphoneStatus.textContent = connected
        ? "Connected"
        : "Disconnected";

    microphoneStatus.dataset.state = connected
        ? "connected"
        : "disconnected";
}

function updateListenerCount(count) {
    listenerCount.textContent = String(count);
}

function updateLevel(samples) {
    if (samples.length === 0) {
        return;
    }

    let sumSquares = 0;

    for (
        let index = 0;
        index < samples.length;
        index += 1
    ) {
        const sample = samples[index];
        sumSquares += sample * sample;
    }

    const rms = Math.sqrt(
        sumSquares / samples.length
    );

    const percentage = Math.min(
        100,
        Math.round(rms * 300)
    );

    audioLevel.value = percentage;
    levelText.textContent = `${percentage}%`;
}


/* ---------------------------------------------------------
   PCM conversion
--------------------------------------------------------- */

function pcm16ToFloat32(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const sampleCount = Math.floor(
        arrayBuffer.byteLength / 2
    );

    const samples = new Float32Array(sampleCount);

    for (
        let index = 0;
        index < sampleCount;
        index += 1
    ) {
        const pcmValue = view.getInt16(
            index * 2,
            true
        );

        samples[index] = pcmValue / 32768;
    }

    return samples;
}


/* ---------------------------------------------------------
   Audio initialization
--------------------------------------------------------- */

async function createAudioPlayer() {
    audioContext = new AudioContext({
        latencyHint: "interactive"
    });

    await audioContext.resume();

    const workletBlob = new Blob(
        [workletSource],
        {
            type: "application/javascript"
        }
    );

    const workletUrl = URL.createObjectURL(
        workletBlob
    );

    try {
        await audioContext.audioWorklet.addModule(
            workletUrl
        );
    } finally {
        URL.revokeObjectURL(workletUrl);
    }

    const startBufferSamples = Math.round(
        audioContext.sampleRate *
        START_BUFFER_SECONDS
    );

    const maxBufferSamples = Math.round(
        audioContext.sampleRate *
        MAX_BUFFER_SECONDS
    );

    workletNode = new AudioWorkletNode(
        audioContext,
        "pcm-stream-processor",
        {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [1],

            processorOptions: {
                startBufferSamples,
                maxBufferSamples
            }
        }
    );

    workletNode.port.onmessage = (event) => {
        const message = event.data;

        if (message.type === "playback-started") {
            setConnectionStatus(
                "Playing live audio",
                "connected"
            );
        }

        if (message.type === "buffer-underrun") {
            if (
                webSocket &&
                webSocket.readyState === WebSocket.OPEN
            ) {
                setConnectionStatus(
                    "Buffering audio...",
                    "connecting"
                );
            }
        }
    };

    workletNode.connect(
        audioContext.destination
    );

    resampler = new StreamingResampler(
        SOURCE_SAMPLE_RATE,
        audioContext.sampleRate
    );

    console.log(
        `AudioContext sample rate: ` +
        `${audioContext.sampleRate} Hz`
    );
}


/* ---------------------------------------------------------
   WebSocket
--------------------------------------------------------- */

function buildWebSocketUrl() {
    const protocol =
        window.location.protocol === "https:"
            ? "wss:"
            : "ws:";

    return (
        `${protocol}//` +
        `${window.location.host}/listen`
    );
}

function connectWebSocket() {
    clearTimeout(reconnectTimer);

    if (!shouldReconnect) {
        return;
    }

    setConnectionStatus(
        "Connecting to server...",
        "connecting"
    );

    const socketUrl = buildWebSocketUrl();

    console.log(
        `Connecting to ${socketUrl}`
    );

    webSocket = new WebSocket(socketUrl);
    webSocket.binaryType = "arraybuffer";

    webSocket.addEventListener("open", () => {
        setConnectionStatus(
            "Connected — waiting for audio",
            "connected"
        );

        webSocket.send(
            JSON.stringify({
                type: "request-status"
            })
        );
    });

    webSocket.addEventListener(
        "message",
        handleWebSocketMessage
    );

    webSocket.addEventListener("close", () => {
        setConnectionStatus(
            "Server disconnected",
            "disconnected"
        );

        updateMicrophoneStatus(false);

        if (workletNode) {
            workletNode.port.postMessage({
                type: "clear"
            });
        }

        if (resampler) {
            resampler.reset();
        }

        if (shouldReconnect) {
            reconnectTimer = setTimeout(
                connectWebSocket,
                RECONNECT_DELAY_MS
            );
        }
    });

    webSocket.addEventListener("error", () => {
        console.error(
            "WebSocket connection error"
        );
    });
}

function handleWebSocketMessage(event) {
    if (typeof event.data === "string") {
        handleServerMessage(event.data);
        return;
    }

    if (!(event.data instanceof ArrayBuffer)) {
        return;
    }

    if (!workletNode || !resampler) {
        return;
    }

    const sourceSamples =
        pcm16ToFloat32(event.data);

    updateLevel(sourceSamples);

    const outputSamples =
        resampler.process(sourceSamples);

    if (outputSamples.length === 0) {
        return;
    }

    workletNode.port.postMessage(
        {
            type: "audio",
            samples: outputSamples
        },
        [outputSamples.buffer]
    );
}

function handleServerMessage(text) {
    let message;

    try {
        message = JSON.parse(text);
    } catch (error) {
        console.warn(
            "Invalid server message:",
            text
        );

        return;
    }

    if (message.type === "status") {
        updateMicrophoneStatus(
            Boolean(message.microphoneConnected)
        );

        updateListenerCount(
            Number(message.listenerCount || 0)
        );

        if (!message.microphoneConnected) {
            setConnectionStatus(
                "Waiting for ESP32 microphone",
                "connecting"
            );
        }

        return;
    }

    if (message.type === "audio-format") {
        console.log(
            "Audio format:",
            message
        );

        return;
    }
}


/* ---------------------------------------------------------
   Start and stop
--------------------------------------------------------- */

async function startListening() {
    startButton.disabled = true;

    try {
        if (!audioContext) {
            await createAudioPlayer();
        }

        if (audioContext.state === "suspended") {
            await audioContext.resume();
        }

        shouldReconnect = true;
        stopButton.disabled = false;

        connectWebSocket();
    } catch (error) {
        console.error(error);

        setConnectionStatus(
            `Audio error: ${error.message}`,
            "disconnected"
        );

        startButton.disabled = false;
    }
}

async function stopListening() {
    shouldReconnect = false;

    clearTimeout(reconnectTimer);

    if (webSocket) {
        webSocket.close();
        webSocket = null;
    }

    if (workletNode) {
        workletNode.port.postMessage({
            type: "clear"
        });
    }

    if (resampler) {
        resampler.reset();
    }

    if (audioContext) {
        await audioContext.suspend();
    }

    setConnectionStatus(
        "Stopped",
        "disconnected"
    );

    updateMicrophoneStatus(false);
    updateListenerCount(0);

    audioLevel.value = 0;
    levelText.textContent = "0%";

    startButton.disabled = false;
    stopButton.disabled = true;
}


/* ---------------------------------------------------------
   Events
--------------------------------------------------------- */

startButton.addEventListener(
    "click",
    startListening
);

stopButton.addEventListener(
    "click",
    stopListening
);

window.addEventListener("beforeunload", () => {
    shouldReconnect = false;

    if (webSocket) {
        webSocket.close();
    }
});

setConnectionStatus(
    "Press Start Listening",
    "disconnected"
);

updateMicrophoneStatus(false);
updateListenerCount(0);