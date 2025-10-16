// firmware-esp32/src/main.cpp
//
// ESP32 + HX711 -> UART (Serial1) @ 115200
// Protocolo por línea: G:<gramos>,S:<0|1>
// Comandos desde la Pi: "T" (Tara) y "C:<peso>" (Calibrar con peso patrón en gramos)
//
// - Filtro: mediana (ventana N) + IIR (alpha)
// - Estabilidad: ventana temporal con umbral
// - Persistencia: factor de calibración y tara en NVS (Preferences)
// - Protección: límite de longitud de comando y error si se excede
//
// Pines por defecto (ajustables):
//   HX711_DOUT = GPIO 4
//   HX711_SCK  = GPIO 5
//   UART1_TX   = GPIO 17
//   UART1_RX   = GPIO 16
//
// Cableado con Raspberry Pi (3V3):
//   ESP32 TX (UART1_TX) -> Pi RX (GPIO15/pin10)
//   ESP32 RX (UART1_RX) -> Pi TX (GPIO14/pin8)
//   GND común
//
// Requisitos de librerías (Arduino IDE):
//   - HX711 (bogde): https://github.com/bogde/HX711
//   - Preferences (core ESP32)
//   - Core ESP32 de Espressif
//
// Compilación: ESP32 DevKit / WROOM / equivalente

#include <Arduino.h>
#include <HX711.h>
#include <Preferences.h>
#include <algorithm>  // std::sort
#include <math.h>     // fabsf

// ---------- CONFIG PINES ----------
#ifndef HX711_DOUT_PIN
#define HX711_DOUT_PIN 4
#endif

#ifndef HX711_SCK_PIN
#define HX711_SCK_PIN 5
#endif

#ifndef UART1_TX_PIN
#define UART1_TX_PIN 17
#endif

#ifndef UART1_RX_PIN
#define UART1_RX_PIN 16
#endif

// ---------- SERIAL ----------
static const uint32_t BAUD     = 115200;   // Serial1 (a la Pi)
static const uint32_t BAUD_USB = 115200;   // Serial (debug USB)

// ---------- FILTRO / ESTABILIDAD ----------
static const size_t  MEDIAN_WINDOW   = 15;    // impar recomendado
static const float   IIR_ALPHA       = 0.20f; // 0-1
static const float   STABLE_DELTA_G  = 1.0f;  // umbral en gramos
static const uint32_t STABLE_MS      = 700;   // ms
static const uint16_t LOOP_HZ        = 50;    // Hz aprox

// ---------- NVS ----------
static const char* NVS_NAMESPACE   = "bascula";
static const char* KEY_CAL_FACTOR  = "cal_f";
static const char* KEY_TARE_OFFSET = "tare";

// ---------- COMANDOS ----------
static const size_t CMD_MAX_LEN = 80;     // límite seguro para líneas de comando

// ---------- OBJETOS ----------
HX711      scale;
Preferences prefs;

// ---------- ESTADO ----------
volatile float   g_calFactor  = 1.0f;  // unidades crudas -> gramos
volatile int32_t g_tareOffset = 0;     // offset de tara (unidades crudas)

// ---------- BUFFER MEDIANA ----------
class RingBuffer {
public:
  explicit RingBuffer(size_t n) : N(n), idx(0), count(0) {
    buf = new long[N];
    for (size_t i = 0; i < N; ++i) buf[i] = 0;
  }
  ~RingBuffer() { delete[] buf; }

  void add(long v) {
    buf[idx] = v;
    idx = (idx + 1) % N;
    if (count < N) count++;
  }

  size_t size() const { return count; }

  long median() const {
    if (count == 0) return 0;
    long* tmp = new long[count];
    for (size_t i = 0; i < count; ++i) tmp[i] = buf[i];
    std::sort(tmp, tmp + count);
    long m = tmp[count / 2]; // usar ventana impar
    delete[] tmp;
    return m;
  }

private:
  long*  buf;
  size_t N;
  size_t idx;
  size_t count;
};

// ---------- UTILS ----------
static inline long readRaw() {
  return scale.read(); // 24-bit signed
}

static inline float rawToGrams(long raw) {
  long raw_net = raw - g_tareOffset;
  return (float)raw_net * g_calFactor;
}

// ---------- PARSEO DE COMANDOS ----------
String cmdLine;
bool   cmdOverflow = false;

void handleCommand(const String& line) {
  // "T"         -> Tara (guardar offset actual)
  // "C:<peso>"  -> Calibrar con peso patrón en gramos
  if (line.length() == 0) return;

  if (line == "T" || line == "t") {
    long r = readRaw();
    g_tareOffset = r;
    prefs.putInt(KEY_TARE_OFFSET, g_tareOffset);
    Serial.println(F("[NVS] Tara guardada"));
    Serial1.println(F("ACK:T"));
    return;
  }

  if (line.startsWith("C:") || line.startsWith("c:")) {
    String w = line.substring(2);
    w.trim();
    float peso_ref = w.toFloat();
    if (peso_ref <= 0.0f) {
      Serial1.println(F("ERR:CAL:weight"));
      return;
    }
    const int N = 20;
    long acc = 0;
    for (int i = 0; i < N; ++i) {
      acc += readRaw();
      delay(5);
    }
    long r_mean = acc / N;
    long r_net  = r_mean - g_tareOffset;
    if (r_net == 0) {
      Serial1.println(F("ERR:CAL:zero"));
      return;
    }
    g_calFactor = (float)peso_ref / (float)r_net;
    prefs.putFloat(KEY_CAL_FACTOR, g_calFactor);
    Serial.print(F("[NVS] Calibración guardada. Factor: "));
    Serial.println(g_calFactor, 8);
    Serial1.print(F("ACK:C:"));
    Serial1.println(g_calFactor, 8);
    return;
  }

  Serial1.println(F("ERR:UNKNOWN_CMD"));
}

// ---------- SETUP ----------
void setup() {
  Serial.begin(BAUD_USB);
  delay(150);

  Serial1.begin(BAUD, SERIAL_8N1, UART1_RX_PIN, UART1_TX_PIN);
  delay(100);

  Serial.println();
  Serial.println(F("== Bascula ESP32 + HX711 @ UART =="));
  Serial.print(F("UART1 TX=")); Serial.print(UART1_TX_PIN);
  Serial.print(F(" RX=")); Serial.println(UART1_RX_PIN);

  scale.begin(HX711_DOUT_PIN, HX711_SCK_PIN);
  delay(50);

  prefs.begin(NVS_NAMESPACE, false);
  g_calFactor  = prefs.getFloat(KEY_CAL_FACTOR, 1.0f);
  g_tareOffset = prefs.getInt(KEY_TARE_OFFSET, 0);

  Serial.print(F("CalFactor: ")); Serial.println(g_calFactor, 8);
  Serial.print(F("TareOffset: ")); Serial.println(g_tareOffset);

  Serial1.println(F("HELLO:ESP32-HX711"));
}

// ---------- LOOP ----------
void loop() {
  static RingBuffer rb(MEDIAN_WINDOW);
  static bool first = true;
  static float iir_value = 0.0f;
  static uint32_t lastStableRefMs = 0;
  static bool stable = false;

  // 1) Leer crudo y alimentar mediana
  long raw = readRaw();
  rb.add(raw);

  // 2) Mediana + IIR
  float grams;
  if (rb.size() >= 3) {
    long med = rb.median();
    float g  = rawToGrams(med);
    if (first) {
      iir_value = g;
      first = false;
    } else {
      iir_value = (1.0f - IIR_ALPHA) * iir_value + IIR_ALPHA * g;
    }
    grams = iir_value;
  } else {
    grams = rawToGrams(raw);
  }

  // 3) Estabilidad temporal
  static float last_grams = 0.0f;
  float delta = fabsf(grams - last_grams);
  uint32_t now = millis();

  if (delta <= STABLE_DELTA_G) {
    if ((now - lastStableRefMs) >= STABLE_MS) {
      stable = true;
    }
  } else {
    stable = false;
    lastStableRefMs = now;
  }
  last_grams = grams;

  // 4) Emitir trama única: "G:<valor>,S:<0|1>"
  char out[64];
  snprintf(out, sizeof(out), "G:%.2f,S:%d", grams, stable ? 1 : 0);
  Serial1.println(out);

  // 5) Leer comandos de la Pi con control de longitud
  while (Serial1.available()) {
    char c = (char)Serial1.read();
    if (c == '\r' || c == '\n') {
      // fin de línea
      if (cmdOverflow) {
        // Hemos descartado parte del comando por longitud
        Serial1.println(F("ERR:CMDLEN"));
      } else {
        cmdLine.trim();
        if (cmdLine.length() > 0) {
          handleCommand(cmdLine);
        }
      }
      cmdLine = "";
      cmdOverflow = false;
    } else {
      if (!cmdOverflow) {
        if (cmdLine.length() < CMD_MAX_LEN) {
          cmdLine += c;
        } else {
          // marcar overflow y seguir leyendo hasta fin de línea para vaciar buffer
          cmdOverflow = true;
        }
      }
    }
  }

  // 6) Ritmo de lazo
  delay(1000 / LOOP_HZ);
}
