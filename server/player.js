"use strict";

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

const micGainSlider = document.getElementById("micGain");
const micGainText = document.getElementById("micGainText");
const playbackVolumeSlider = document.getElementById("playbackVolume");
const playbackVolumeText = document.getElementById("playbackVolumeText");
const limiterToggle = document.getElementById("limiterToggle");
const resetAudioButton = document.getElementById("resetAudioButton");

let audioContext = null;
let workletNode = null;
let micGainNode = null;
let limiterNode = null;
let outputGainNode = null;
let webSocket = null;
let resampler = null;
let shouldReconnect = false;
let reconnectTimer = null;

class StreamingResampler {
    constructor(inputRate, outputRate) {
        this.inputRate = inputRate;
        this.outputRate = outputRate;
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

        const estimatedLength = Math.max(
            0,
            Math.ceil((source.length - 1 - this.position) / this.step)
        );

        const output = new Float32Array(estimatedLength);
        let outputIndex = 0;

        while (
            this.position < source.length - 1 &&
            outputIndex < output.length
        ) {
            const leftIndex = Math.floor(this.position);
            const fraction = this.position - leftIndex;
            const leftSample = source[leftIndex];
            const rightSample = source[leftIndex + 1];

            output[outputIndex] =
                leftSample +
                (rightSample - leftSample) * fraction;

            outputIndex += 1;
            this.position += this.step;
        }

        this.position -= source.length - 1;
        this.previousSample = source[source.length - 1];

        return outputIndex === output.length
            ? output
            : output.slice(0, outputIndex);
    }
}

const workletSource = `
class PCMStreamProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.queue = [];
        this.queueOffset = 0;
        this.bufferedSamples = 0;
        this.started = false;

        const settings = options.processorOptions || {};
        this.startBufferSamples = settings.startBufferSamples || 4096;
        this.maxBufferSamples = settings.maxBufferSamples || 72000;

        this.port.onmessage = (event) => {
            const message = event.data;
            if (!message || !message.type) return;

            if (message.type === "audio") {
                const samples = message.samples;
                if (samples instanceof Float32Array && samples.length > 0) {
                    this.queue.push(samples);
                    this.bufferedSamples += samples.length;
                    this.trimOldAudio();

                    if (!this.started && this.bufferedSamples >= this.startBufferSamples) {
                        this.started = true;
                        this.port.postMessage({ type: "playback-started" });
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
        while (this.bufferedSamples > this.maxBufferSamples && this.queue.length > 0) {
            const remaining = this.queue[0].length - this.queueOffset;
            this.bufferedSamples -= remaining;
            this.queue.shift();
            this.queueOffset = 0;
        }
    }

    readSample() {
        while (this.queue.length > 0) {
            const first = this.queue[0];

            if (this.queueOffset < first.length) {
                const sample = first[this.queueOffset];
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
        const channel = outputs[0][0];
        if (!channel) return true;

        if (!this.started) {
            channel.fill(0);
            return true;
        }

        for (let index = 0; index < channel.length; index += 1) {
            channel[index] = this.readSample();
        }

        if (this.bufferedSamples <= 0) {
            this.started = false;
            this.port.postMessage({ type: "buffer-underrun" });
        }

        return true;
    }
}

registerProcessor("pcm-stream-processor", PCMStreamProcessor);
`;

function setConnectionStatus(text, state) {
    connectionStatus.textContent = text;
    connectionStatus.dataset.state = state;
}

function updateMicrophoneStatus(connected) {
    microphoneStatus.textContent = connected ? "Connected" : "Disconnected";
    microphoneStatus.dataset.state = connected ? "connected" : "disconnected";
}

function updateLevel(samples) {
    if (samples.length === 0) return;

    let sumSquares = 0;
    for (const sample of samples) {
        sumSquares += sample * sample;
    }

    const rms = Math.sqrt(sumSquares / samples.length);
    const percentage = Math.min(100, Math.round(rms * 300));

    audioLevel.value = percentage;
    levelText.textContent = `${percentage}%`;
}

function pcm16ToFloat32(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const samples = new Float32Array(Math.floor(arrayBuffer.byteLength / 2));

    for (let index = 0; index < samples.length; index += 1) {
        samples[index] = view.getInt16(index * 2, true) / 32768;
    }

    return samples;
}

function applyAudioControls() {
    const micGain = Number(micGainSlider.value);
    const playbackVolume = Number(playbackVolumeSlider.value);

    micGainText.textContent = `${micGain.toFixed(2)}×`;
    playbackVolumeText.textContent = `${Math.round(playbackVolume * 100)}%`;

    if (!audioContext) return;

    const now = audioContext.currentTime;

    if (micGainNode) {
        micGainNode.gain.setTargetAtTime(micGain, now, 0.015);
    }

    if (outputGainNode) {
        outputGainNode.gain.setTargetAtTime(playbackVolume, now, 0.015);
    }

    if (limiterNode) {
        limiterNode.threshold.setTargetAtTime(
            limiterToggle.checked ? -3 : 0,
            now,
            0.015
        );

        limiterNode.ratio.setTargetAtTime(
            limiterToggle.checked ? 20 : 1,
            now,
            0.015
        );
    }
}

async function createAudioPlayer() {
    audioContext = new AudioContext({ latencyHint: "interactive" });
    await audioContext.resume();

    const workletUrl = URL.createObjectURL(
        new Blob([workletSource], { type: "application/javascript" })
    );

    try {
        await audioContext.audioWorklet.addModule(workletUrl);
    } finally {
        URL.revokeObjectURL(workletUrl);
    }

    workletNode = new AudioWorkletNode(
        audioContext,
        "pcm-stream-processor",
        {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: {
                startBufferSamples: Math.round(
                    audioContext.sampleRate * START_BUFFER_SECONDS
                ),
                maxBufferSamples: Math.round(
                    audioContext.sampleRate * MAX_BUFFER_SECONDS
                )
            }
        }
    );

    micGainNode = audioContext.createGain();
    limiterNode = audioContext.createDynamicsCompressor();
    outputGainNode = audioContext.createGain();

    limiterNode.knee.value = 0;
    limiterNode.attack.value = 0.003;
    limiterNode.release.value = 0.15;

    workletNode
        .connect(micGainNode)
        .connect(limiterNode)
        .connect(outputGainNode)
        .connect(audioContext.destination);

    workletNode.port.onmessage = (event) => {
        if (event.data.type === "playback-started") {
            setConnectionStatus("Playing live audio", "connected");
        }

        if (event.data.type === "buffer-underrun") {
            if (webSocket && webSocket.readyState === WebSocket.OPEN) {
                setConnectionStatus("Buffering audio...", "connecting");
            }
        }
    };

    resampler = new StreamingResampler(
        SOURCE_SAMPLE_RATE,
        audioContext.sampleRate
    );

    applyAudioControls();
}

function buildWebSocketUrl() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/listen`;
}

function connectWebSocket() {
    clearTimeout(reconnectTimer);
    if (!shouldReconnect) return;

    setConnectionStatus("Connecting to server...", "connecting");

    webSocket = new WebSocket(buildWebSocketUrl());
    webSocket.binaryType = "arraybuffer";

    webSocket.addEventListener("open", () => {
        setConnectionStatus("Connected — waiting for audio", "connected");
        webSocket.send(JSON.stringify({ type: "request-status" }));
    });

    webSocket.addEventListener("message", handleWebSocketMessage);

    webSocket.addEventListener("close", () => {
        setConnectionStatus("Server disconnected", "disconnected");
        updateMicrophoneStatus(false);

        if (workletNode) {
            workletNode.port.postMessage({ type: "clear" });
        }

        if (resampler) {
            resampler.reset();
        }

        if (shouldReconnect) {
            reconnectTimer = setTimeout(connectWebSocket, RECONNECT_DELAY_MS);
        }
    });

    webSocket.addEventListener("error", () => {
        console.error("WebSocket connection error");
    });
}

function handleWebSocketMessage(event) {
    if (typeof event.data === "string") {
        handleServerMessage(event.data);
        return;
    }

    if (!(event.data instanceof ArrayBuffer) || !workletNode || !resampler) {
        return;
    }

    const sourceSamples = pcm16ToFloat32(event.data);
    updateLevel(sourceSamples);

    const outputSamples = resampler.process(sourceSamples);
    if (outputSamples.length === 0) return;

    workletNode.port.postMessage(
        { type: "audio", samples: outputSamples },
        [outputSamples.buffer]
    );
}

function handleServerMessage(text) {
    let message;

    try {
        message = JSON.parse(text);
    } catch {
        return;
    }

    if (message.type === "status") {
        updateMicrophoneStatus(Boolean(message.microphoneConnected));
        listenerCount.textContent = String(Number(message.listenerCount || 0));

        if (!message.microphoneConnected) {
            setConnectionStatus("Waiting for ESP32 microphone", "connecting");
        }
    }
}

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
        setConnectionStatus(`Audio error: ${error.message}`, "disconnected");
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
        workletNode.port.postMessage({ type: "clear" });
    }

    if (resampler) {
        resampler.reset();
    }

    if (audioContext) {
        await audioContext.suspend();
    }

    setConnectionStatus("Stopped", "disconnected");
    updateMicrophoneStatus(false);
    listenerCount.textContent = "0";
    audioLevel.value = 0;
    levelText.textContent = "0%";
    startButton.disabled = false;
    stopButton.disabled = true;
}

function resetAudioControls() {
    micGainSlider.value = "1";
    playbackVolumeSlider.value = "0.7";
    limiterToggle.checked = true;
    applyAudioControls();
}

startButton.addEventListener("click", startListening);
stopButton.addEventListener("click", stopListening);
micGainSlider.addEventListener("input", applyAudioControls);
playbackVolumeSlider.addEventListener("input", applyAudioControls);
limiterToggle.addEventListener("change", applyAudioControls);
resetAudioButton.addEventListener("click", resetAudioControls);

window.addEventListener("beforeunload", () => {
    shouldReconnect = false;
    if (webSocket) webSocket.close();
});

setConnectionStatus("Press Start Listening", "disconnected");
updateMicrophoneStatus(false);
applyAudioControls();
