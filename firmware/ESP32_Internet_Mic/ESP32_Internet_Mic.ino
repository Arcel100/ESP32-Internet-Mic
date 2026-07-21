///////////////////////////////////////////////////////////////
// ESP32 Internet Mic V2
// Board: ESP32-S3 DevKitC
// Mic: INMP441
///////////////////////////////////////////////////////////////

#include <WiFi.h>
#include <WiFiManager.h>
#include <Preferences.h>

#include <driver/i2s.h>

#include <WebSocketsClient.h>

Preferences prefs;
WiFiManager wm;
WebSocketsClient ws;

///////////////////////////////////////////////////////////////
// INMP441 Pins
///////////////////////////////////////////////////////////////

#define I2S_SD   10
#define I2S_WS   11
#define I2S_SCK  12

#define I2S_PORT I2S_NUM_0

///////////////////////////////////////////////////////////////
// Audio
///////////////////////////////////////////////////////////////

#define SAMPLE_RATE 16000

#define DMA_BUFFERS 8
#define DMA_LENGTH 512

int32_t micBuffer[DMA_LENGTH];
int16_t sendBuffer[DMA_LENGTH];

///////////////////////////////////////////////////////////////
// Server
///////////////////////////////////////////////////////////////

String serverHost;
String serverPath;

uint16_t serverPort;

bool wsConnected = false;

///////////////////////////////////////////////////////////////
// Timers
///////////////////////////////////////////////////////////////

unsigned long lastReconnect = 0;
const unsigned long reconnectInterval = 5000;

///////////////////////////////////////////////////////////////
// Preferences
///////////////////////////////////////////////////////////////

void loadSettings()
{
    prefs.begin("internet-mic", true);

    serverHost = prefs.getString(
        "host",
        "YOUR-CLOUDFLARE-HOST"
    );

    serverPort = prefs.getUShort(
        "port",
        443
    );

    serverPath = prefs.getString(
        "path",
        "/mic"
    );

    prefs.end();

    Serial.println();
    Serial.println("Saved server settings:");
    Serial.print("Host: ");
    Serial.println(serverHost);

    Serial.print("Port: ");
    Serial.println(serverPort);

    Serial.print("Path: ");
    Serial.println(serverPath);
}


void saveSettings(
    const String& host,
    uint16_t port,
    const String& path
)
{
    prefs.begin("internet-mic", false);

    prefs.putString("host", host);
    prefs.putUShort("port", port);
    prefs.putString("path", path);

    prefs.end();
}

///////////////////////////////////////////////////////////////
// WiFiManager configuration portal
///////////////////////////////////////////////////////////////

void setupWiFi()
{
    loadSettings();

    char hostBuffer[128];
    char portBuffer[8];
    char pathBuffer[64];

    serverHost.toCharArray(
        hostBuffer,
        sizeof(hostBuffer)
    );

    snprintf(
        portBuffer,
        sizeof(portBuffer),
        "%u",
        serverPort
    );

    serverPath.toCharArray(
        pathBuffer,
        sizeof(pathBuffer)
    );

    WiFiManagerParameter hostParameter(
        "server_host",
        "WebSocket server hostname",
        hostBuffer,
        sizeof(hostBuffer)
    );

    WiFiManagerParameter portParameter(
        "server_port",
        "WebSocket server port",
        portBuffer,
        sizeof(portBuffer)
    );

    WiFiManagerParameter pathParameter(
        "server_path",
        "WebSocket server path",
        pathBuffer,
        sizeof(pathBuffer)
    );

    wm.addParameter(&hostParameter);
    wm.addParameter(&portParameter);
    wm.addParameter(&pathParameter);

    wm.setConfigPortalTimeout(180);

    bool connected = wm.autoConnect(
        "ESP32-MIC-SETUP"
    );

    if (!connected)
    {
        Serial.println(
            "WiFiManager failed. Restarting..."
        );

        delay(2000);
        ESP.restart();
    }

    serverHost = String(
        hostParameter.getValue()
    );

    serverPort = static_cast<uint16_t>(
        atoi(portParameter.getValue())
    );

    serverPath = String(
        pathParameter.getValue()
    );

    serverHost.trim();
    serverPath.trim();

    if (serverPort == 0)
    {
        serverPort = 443;
    }

    if (serverPath.length() == 0)
    {
        serverPath = "/mic";
    }

    if (!serverPath.startsWith("/"))
    {
        serverPath =
            "/" + serverPath;
    }

    saveSettings(
        serverHost,
        serverPort,
        serverPath
    );

    Serial.println();
    Serial.println("WiFi connected");

    Serial.print("ESP32 IP: ");
    Serial.println(WiFi.localIP());

    Serial.print("Signal strength: ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");
}

///////////////////////////////////////////////////////////////
// I2S microphone setup
///////////////////////////////////////////////////////////////

bool setupI2S()
{
    const i2s_config_t i2sConfig =
    {
        .mode = static_cast<i2s_mode_t>(
            I2S_MODE_MASTER |
            I2S_MODE_RX
        ),

        .sample_rate = SAMPLE_RATE,

        .bits_per_sample =
            I2S_BITS_PER_SAMPLE_32BIT,

        .channel_format =
            I2S_CHANNEL_FMT_ONLY_LEFT,

        .communication_format =
            I2S_COMM_FORMAT_STAND_I2S,

        .intr_alloc_flags =
            ESP_INTR_FLAG_LEVEL1,

        .dma_buf_count =
            DMA_BUFFERS,

        .dma_buf_len =
            DMA_LENGTH,

        .use_apll =
            false,

        .tx_desc_auto_clear =
            false,

        .fixed_mclk =
            0
    };

    const i2s_pin_config_t pinConfig =
    {
        .bck_io_num =
            I2S_SCK,

        .ws_io_num =
            I2S_WS,

        .data_out_num =
            I2S_PIN_NO_CHANGE,

        .data_in_num =
            I2S_SD
    };

    esp_err_t result =
        i2s_driver_install(
            I2S_PORT,
            &i2sConfig,
            0,
            nullptr
        );

    if (result != ESP_OK)
    {
        Serial.print(
            "i2s_driver_install failed: "
        );

        Serial.println(
            esp_err_to_name(result)
        );

        return false;
    }

    result =
        i2s_set_pin(
            I2S_PORT,
            &pinConfig
        );

    if (result != ESP_OK)
    {
        Serial.print(
            "i2s_set_pin failed: "
        );

        Serial.println(
            esp_err_to_name(result)
        );

        i2s_driver_uninstall(
            I2S_PORT
        );

        return false;
    }

    result =
        i2s_zero_dma_buffer(
            I2S_PORT
        );

    if (result != ESP_OK)
    {
        Serial.print(
            "i2s_zero_dma_buffer failed: "
        );

        Serial.println(
            esp_err_to_name(result)
        );
    }

    Serial.println(
        "I2S microphone initialized"
    );

    return true;
}

///////////////////////////////////////////////////////////////
// WebSocket events
///////////////////////////////////////////////////////////////

void webSocketEvent(
    WStype_t type,
    uint8_t* payload,
    size_t length
)
{
    switch (type)
    {
        case WStype_CONNECTED:
        {
            wsConnected = true;

            Serial.println(
                "Connected to WebSocket server"
            );

            break;
        }

        case WStype_DISCONNECTED:
        {
            wsConnected = false;

            Serial.println(
                "WebSocket disconnected"
            );

            break;
        }

        case WStype_ERROR:
        {
            wsConnected = false;

            Serial.println(
                "WebSocket error"
            );

            break;
        }

        case WStype_TEXT:
        {
            Serial.print(
                "Server message: "
            );

            Serial.write(
                payload,
                length
            );

            Serial.println();

            break;
        }

        case WStype_PING:
        {
            Serial.println(
                "WebSocket ping received"
            );

            break;
        }

        case WStype_PONG:
        {
            break;
        }

        default:
        {
            break;
        }
    }
}

///////////////////////////////////////////////////////////////
// WebSocket setup
///////////////////////////////////////////////////////////////

void setupWebSocket()
{
    ws.onEvent(webSocketEvent);

    ws.beginSSL(
        serverHost.c_str(),
        serverPort,
        serverPath.c_str()
    );

    ws.setReconnectInterval(reconnectInterval);

    ws.enableHeartbeat(
        15000,
        3000,
        2
    );

    Serial.print("Connecting to wss://");
    Serial.print(serverHost);
    Serial.print(":");
    Serial.print(serverPort);
    Serial.println(serverPath);
}

///////////////////////////////////////////////////////////////
// Audio conversion
///////////////////////////////////////////////////////////////

// INMP441 provides 24-bit audio inside a 32-bit I2S sample.
//
// Increase this value if audio is too loud or distorted.
// Decrease it if audio is too quiet.
//
// Common working range: 12–16
constexpr int AUDIO_SHIFT = 14;

// Prevent extremely large clicks caused by malformed samples.
constexpr int32_t PCM16_MIN_VALUE = -32768;
constexpr int32_t PCM16_MAX_VALUE = 32767;


int16_t convertSampleToPCM16(int32_t rawSample)
{
    int32_t convertedSample =
        rawSample >> AUDIO_SHIFT;

    if (convertedSample > PCM16_MAX_VALUE)
    {
        convertedSample = PCM16_MAX_VALUE;
    }
    else if (convertedSample < PCM16_MIN_VALUE)
    {
        convertedSample = PCM16_MIN_VALUE;
    }

    return static_cast<int16_t>(
        convertedSample
    );
}


size_t convertAudioBuffer(
    const int32_t* input,
    int16_t* output,
    size_t sampleCount
)
{
    for (size_t index = 0;
         index < sampleCount;
         index++)
    {
        output[index] =
            convertSampleToPCM16(
                input[index]
            );
    }

    return sampleCount;
}

///////////////////////////////////////////////////////////////
// Read and stream microphone audio
///////////////////////////////////////////////////////////////

void streamAudio()
{
    if (!wsConnected)
    {
        return;
    }

    if (WiFi.status() != WL_CONNECTED)
    {
        return;
    }

    size_t bytesRead = 0;

    const esp_err_t result =
        i2s_read(
            I2S_PORT,
            micBuffer,
            sizeof(micBuffer),
            &bytesRead,
            pdMS_TO_TICKS(10)
        );

    if (result != ESP_OK)
    {
        static unsigned long lastErrorMessage = 0;

        if (millis() - lastErrorMessage >= 2000)
        {
            Serial.print(
                "I2S read failed: "
            );

            Serial.println(
                esp_err_to_name(result)
            );

            lastErrorMessage = millis();
        }

        return;
    }

    if (bytesRead == 0)
    {
        return;
    }

    const size_t sampleCount =
        bytesRead / sizeof(int32_t);

    const size_t convertedSamples =
        convertAudioBuffer(
            micBuffer,
            sendBuffer,
            sampleCount
        );

    const size_t outputBytes =
        convertedSamples *
        sizeof(int16_t);

    ws.sendBIN(
        reinterpret_cast<uint8_t*>(
            sendBuffer
        ),
        outputBytes
    );
}

///////////////////////////////////////////////////////////////
// Wi-Fi monitoring
///////////////////////////////////////////////////////////////

void monitorWiFi()
{
    static bool previouslyConnected = true;
    static unsigned long lastStatusMessage = 0;

    const bool currentlyConnected =
        WiFi.status() == WL_CONNECTED;

    if (currentlyConnected != previouslyConnected)
    {
        previouslyConnected =
            currentlyConnected;

        if (currentlyConnected)
        {
            Serial.println(
                "Wi-Fi connection restored"
            );

            Serial.print(
                "ESP32 IP: "
            );

            Serial.println(
                WiFi.localIP()
            );
        }
        else
        {
            Serial.println(
                "Wi-Fi connection lost"
            );

            wsConnected = false;
        }
    }

    if (!currentlyConnected &&
        millis() - lastStatusMessage >= 10000)
    {
        Serial.println(
            "Waiting for Wi-Fi reconnection..."
        );

        lastStatusMessage = millis();
    }
}

///////////////////////////////////////////////////////////////
// Serial startup information
///////////////////////////////////////////////////////////////

void printStartupBanner()
{
    Serial.println();
    Serial.println(
        "================================"
    );

    Serial.println(
        "     ESP32 Internet Mic V2"
    );

    Serial.println(
        "================================"
    );

    Serial.println(
        "Board: ESP32-S3 DevKitC"
    );

    Serial.println(
        "Microphone: INMP441"
    );

    Serial.print(
        "Sample rate: "
    );

    Serial.print(
        SAMPLE_RATE
    );

    Serial.println(
        " Hz"
    );

    Serial.println(
        "Output format: signed PCM16 mono"
    );

    Serial.println();
}

///////////////////////////////////////////////////////////////
// Arduino setup
///////////////////////////////////////////////////////////////

void setup()
{
    Serial.begin(115200);

    delay(1500);

    printStartupBanner();

    WiFi.mode(
        WIFI_STA
    );

    WiFi.setAutoReconnect(
        true
    );

    WiFi.persistent(
        true
    );

    setupWiFi();

    if (!setupI2S())
    {
        Serial.println();
        Serial.println(
            "Fatal error: microphone setup failed"
        );

        Serial.println(
            "Check the INMP441 wiring:"
        );

        Serial.println(
            "SD  -> GPIO 10"
        );

        Serial.println(
            "WS  -> GPIO 11"
        );

        Serial.println(
            "SCK -> GPIO 12"
        );

        Serial.println(
            "L/R -> GND"
        );

        while (true)
        {
            delay(1000);
        }
    }

    setupWebSocket();

    Serial.println();
    Serial.println(
        "Setup complete"
    );

    Serial.println(
        "Waiting for WebSocket connection..."
    );
}

///////////////////////////////////////////////////////////////
// Arduino loop
///////////////////////////////////////////////////////////////

void loop()
{
    monitorWiFi();

    if (WiFi.status() == WL_CONNECTED)
    {
        // Handles WebSocket connection, heartbeat,
        // incoming messages, and automatic reconnects.
        ws.loop();

        // Capture and transmit one block of audio.
        streamAudio();
    }
    else
    {
        delay(10);
    }

    // Gives Wi-Fi and system background tasks CPU time.
    delay(1);
}