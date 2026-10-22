/* GrowAI - ESP32-CAM (AI-Thinker)

   Desde a cam-2.0.0 a placa fica ACORDADA e ligada na tomada. Ela faz duas
   coisas ao mesmo tempo:

   1. Ao vivo: fica conectada ao backend por WebSocket (/ws, com a chave dela)
      e, enquanto alguem estiver com o visor da tela Camera aberto, manda
      ~2 quadros JPEG por segundo. Ninguem olhando = nenhum quadro.
   2. Foto da IA: a cada FOTO_INTERVALO_MIN minutos (:00 e :30), dentro da
      janela em que o ESP32 principal apaga o LED Grow, tira uma foto com
      flash e manda para POST /device/foto, onde a IA analisa. Fora dessa
      janela a luz roxa falseia as cores -- por isso o ao vivo aparece roxo e
      a foto da IA nao.

   Antes (ate a cam-1.2.1) ela dormia 29 de cada 30 minutos em deep sleep, e
   nao havia como ver a horta "agora".

   Esta placa nunca fala com a IA e nao guarda nenhuma chave de IA. */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <esp_camera.h>
#include <time.h>
/* Preferences vem incluido aqui, e nao so dentro de shared/provisao.h, porque
   o resolvedor de bibliotecas do PlatformIO varre apenas src/ e include/ do
   projeto: um #include que exista somente no shared/ nao faz a biblioteca do
   core ser encontrada, e o build falha com "Preferences.h: No such file". */
#include <Preferences.h>

#include <ArduinoJson.h>
#include <WebSocketsClient.h>
#include <WiFiManager.h>

#include "protocolo.h"
#include "provisao.h"
#include "secrets.h"

#define FW "cam-2.2.0"

// -------------------------------------------- pinagem AI-Thinker (padrao)
#define PWDN_GPIO_NUM  32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM   0
#define SIOD_GPIO_NUM  26
#define SIOC_GPIO_NUM  27
#define Y9_GPIO_NUM    35
#define Y8_GPIO_NUM    34
#define Y7_GPIO_NUM    39
#define Y6_GPIO_NUM    36
#define Y5_GPIO_NUM    21
#define Y4_GPIO_NUM    19
#define Y3_GPIO_NUM    18
#define Y2_GPIO_NUM     5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM  23
#define PCLK_GPIO_NUM  22

const uint8_t PIN_FLASH = 4;      // LED branco da placa; forte, so na foto da IA
/* LED vermelho pequeno no verso da AI-Thinker, aceso em LOW:
     piscando devagar (10 s) -> acabou de ligar: aperte o RST de novo para
                                abrir o portal (reset duplo)
     3 piscadas rapidas      -> conectou no Wi-Fi
     1 piscada longa         -> foto da IA entregue ao backend
     aceso fixo              -> portal de configuracao aberto (GrowAI-setup)
   Durante o ao vivo ele fica APAGADO: apareceria na imagem. */
const uint8_t PIN_LED   = 33;

const unsigned long WIFI_TIMEOUT_MS         = 20000;
const unsigned long WIFI_RESERVA_TIMEOUT_MS = 15000;  // rede reserva do secrets.h
const unsigned long WIFI_SEM_REDE_MAX_MS    = 5UL * 60 * 1000; // sem Wi-Fi: reinicia
const unsigned long FLASH_MAX_MS            = 2000;

// Ao vivo: intervalo entre quadros e quanto tempo segue sem ouvir o backend.
const unsigned long QUADRO_MS       = 500;    // ~2 quadros por segundo
const unsigned long AO_VIVO_PRAZO_MS = 25000; // o backend renova a cada 10 s

/* Falhas seguidas de Wi-Fi no boot. RTC_NOINIT sobrevive ao ESP.restart()
   (mas nao a falta de energia). Depois de FALHAS_ATE_PORTAL reinicios sem
   conseguir conectar, a placa assume que a rede mudou e abre o portal. */
RTC_NOINIT_ATTR int falhasWifi;
static const int FALHAS_ATE_PORTAL = 3;

struct tm tmAgora;

WiFiClient       clienteHttp;
WiFiClientSecure clienteHttps;
WebSocketsClient ws;
String cabecalhoChave;   // "X-Device-Key: ..." -- precisa viver enquanto o ws existir

/* Wi-Fi, API_BASE e DEVICE_KEY vem da NVS (ver provisao.h); o secrets.h entra
   so como valor de fabrica. */
Credenciais cred;

bool aoVivo = false;
unsigned long aoVivoAte = 0;
unsigned long tUltimoQuadro = 0;
long ultimoCicloFoto = -1;     // qual janela de foto ja foi atendida
/* cam-2.2.0: "Trocar rede Wi-Fi" no app chega pelo WebSocket ({tipo:"portal"}).
   O evento so marca; o loop() esquece a rede e abre o portal. */
bool pedidoPortal = false;

bool ehHttps() { return cred.apiBase.startsWith("https"); }

// ------------------------------------------------------------------ LED
void led(bool aceso) { digitalWrite(PIN_LED, aceso ? LOW : HIGH); }

void pisca(int vezes, int ms) {
  for (int i = 0; i < vezes; i++) {
    led(true);  delay(ms);
    led(false); delay(ms);
  }
}

/* ------------------------------------------------------------ reset duplo
   Gatilho do portal nesta placa: apertar o RST duas vezes seguidas (ou tirar
   e por a energia duas vezes). O contador fica na NVS porque o RST zera a
   memoria RTC; reinicio por software ou brownout nao conta. Ele zera depois
   de RESET_JANELA_MS acordada: e a janela do segundo aperto, marcada pelo
   LED piscando devagar. */
static const char *NVS_CAM = "growai-cam";
bool bootManual = false;
bool janelaResetAberta = false;
const unsigned long RESET_JANELA_MS = 10000;

bool resetDuplo() {
  esp_reset_reason_t motivo = esp_reset_reason();
  if (motivo != ESP_RST_POWERON && motivo != ESP_RST_EXT) return false;
  bootManual = true;
  janelaResetAberta = true;
  // Ligou na tomada: o RTC_NOINIT vem com lixo, entao o contador recomeca.
  falhasWifi = 0;
  Preferences nvs;
  nvs.begin(NVS_CAM, false);
  int n = nvs.getInt("rst", 0) + 1;
  nvs.putInt("rst", n >= 2 ? 0 : n);
  nvs.end();
  return n >= 2;
}

void zeraResetDuplo() {
  Preferences nvs;
  nvs.begin(NVS_CAM, false);
  if (nvs.getInt("rst", 0) != 0) nvs.putInt("rst", 0);
  nvs.end();
}

// Pisca devagar ate fechar a janela do segundo aperto. Nao bloqueia.
void cuidaJanelaReset() {
  if (!janelaResetAberta) return;
  if (millis() >= RESET_JANELA_MS) {
    janelaResetAberta = false;
    led(false);
    zeraResetDuplo();
    return;
  }
  led((millis() / 250) % 2 == 0);
}

/* Portal de configuracao. Aqui ele PODE bloquear: a CAM nao controla bomba
   nem luz. O timeout evita que ela fique presa esperando para sempre. */
void abrePortal(const char *motivo) {
  Serial.printf("\n[portal] %s\n", motivo);
  Serial.printf("[portal] conecte-se a rede \"%s\" (senha %s)\n", PORTAL_SSID, PORTAL_SENHA);

  digitalWrite(PIN_FLASH, LOW);
  zeraResetDuplo();
  janelaResetAberta = false;
  led(true);                     // aceso fixo enquanto o portal estiver no ar

  WiFiManager wm;
  WiFiManagerParameter pApi("api", "Endereco da API", cred.apiBase.c_str(), 120);
  WiFiManagerParameter pKey("key", "Chave desta placa (cam)", cred.deviceKey.c_str(), 96);
  wm.addParameter(&pApi);
  wm.addParameter(&pKey);
  wm.setConfigPortalTimeout(PORTAL_TIMEOUT_S);
  wm.setTitle("GrowAI - camera");

  bool ok = wm.startConfigPortal(PORTAL_SSID, PORTAL_SENHA);
  if (!ok) {
    Serial.println("[portal] ninguem configurou dentro do tempo; reiniciando");
    falhasWifi = 0;
    delay(200);
    ESP.restart();
  }

  cred.ssid      = WiFi.SSID();
  cred.senha     = WiFi.psk();
  cred.apiBase   = provisaoNormalizaUrl(String(pApi.getValue()));
  cred.deviceKey = String(pKey.getValue());
  cred.deviceKey.trim();
  provisaoSalvar(cred);
  Serial.println("[portal] credenciais salvas na NVS, reiniciando...");
  provisaoMostrar(cred);
  falhasWifi = 0;
  delay(400);
  ESP.restart();
}

// ---------------------------------------------------------------- Wi-Fi
bool conectaWifi(const String &ssid, const String &senha, unsigned long timeoutMs) {
  WiFi.begin(ssid.c_str(), senha.c_str());
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < timeoutMs) {
    delay(200);
    cuidaJanelaReset();
  }
  return WiFi.status() == WL_CONNECTED;
}

// ---------------------------------------------------------------- camera
/* O sensor comeca configurado para a foto da IA (SVGA, qualidade 12). O ao
   vivo usa VGA com mais compressao: ~15-30 kB por quadro em vez de 40-90 kB,
   o que faz diferenca no 4G. modoFoto()/modoAoVivo() trocam na hora. */
bool iniciaCamera() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer   = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM;   c.pin_d1 = Y3_GPIO_NUM;
  c.pin_d2 = Y4_GPIO_NUM;   c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM;   c.pin_d5 = Y7_GPIO_NUM;
  c.pin_d6 = Y8_GPIO_NUM;   c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM;   c.pin_pclk  = PCLK_GPIO_NUM;
  c.pin_vsync = VSYNC_GPIO_NUM; c.pin_href  = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM; c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM;   c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;
  c.frame_size   = FRAMESIZE_SVGA;   // 800x600: detalhe suficiente para a folha
  c.jpeg_quality = 12;               // 10-63, menor = melhor
  c.grab_mode    = CAMERA_GRAB_LATEST;

  if (psramFound()) {
    c.fb_count    = 2;
    c.fb_location = CAMERA_FB_IN_PSRAM;
  } else {
    // Sem PSRAM a SVGA nao cabe na RAM interna: cai para VGA.
    Serial.println("[cam] AVISO: PSRAM nao encontrada, usando VGA");
    c.frame_size  = FRAMESIZE_VGA;
    c.fb_count    = 1;
    c.fb_location = CAMERA_FB_IN_DRAM;
  }

  esp_err_t e = esp_camera_init(&c);
  if (e != ESP_OK) {
    Serial.printf("[cam] esp_camera_init falhou: 0x%x\n", e);
    return false;
  }

  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    s->set_whitebal(s, 1);   // AWB e AEC automaticos: a luz varia
    s->set_awb_gain(s, 1);
    s->set_exposure_ctrl(s, 1);
    s->set_gain_ctrl(s, 1);
    s->set_vflip(s, 0);
    s->set_hmirror(s, 0);
  }
  return true;
}

void modoFoto() {
  sensor_t *s = esp_camera_sensor_get();
  if (!s) return;
  s->set_framesize(s, psramFound() ? FRAMESIZE_SVGA : FRAMESIZE_VGA);
  s->set_quality(s, 12);
}

void modoAoVivo() {
  sensor_t *s = esp_camera_sensor_get();
  if (!s) return;
  s->set_framesize(s, FRAMESIZE_VGA);
  s->set_quality(s, 18);
}

// Descarta os quadros que ja estavam no buffer (velhos ou da resolucao antiga).
void descartaQuadros(int n) {
  for (int i = 0; i < n; i++) {
    camera_fb_t *lixo = esp_camera_fb_get();
    if (lixo) esp_camera_fb_return(lixo);
  }
}

camera_fb_t* capturaComFlash() {
  digitalWrite(PIN_FLASH, HIGH);
  unsigned long tFlash = millis();
  // Os primeiros saem escuros, antes do AWB/AEC reagirem ao flash.
  descartaQuadros(2);
  camera_fb_t *fb = esp_camera_fb_get();
  digitalWrite(PIN_FLASH, LOW);
  unsigned long dur = millis() - tFlash;
  if (dur > FLASH_MAX_MS) Serial.printf("[cam] AVISO: flash ficou %lu ms aceso\n", dur);
  return fb;
}

// ------------------------------------------------------- foto para a IA
// POST de um JPEG para uma rota de /api/device (foto da IA ou quadro de luz).
bool enviaJpeg(const char *rota, camera_fb_t *fb, time_t capturadaEm) {
  HTTPClient http;
  String url = cred.apiBase + rota;
  bool aberto;
  if (ehHttps()) {
    /* setInsecure(): nao valida o certificado. Mesma decisao (e mesmo risco
       aceito) do ESP32 principal, documentada em PROTOCOLO.md. */
    clienteHttps.setInsecure();
    aberto = http.begin(clienteHttps, url);
  } else {
    aberto = http.begin(clienteHttp, url);
  }
  if (!aberto) { Serial.println("[http] URL invalida, confira API_BASE"); return false; }

  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "image/jpeg");
  http.addHeader("X-Device-Key", cred.deviceKey.c_str());
  http.addHeader("X-Captured-At", String((long)capturadaEm));
  http.addHeader("X-Fw", FW);

  int code = http.POST(fb->buf, fb->len);
  Serial.printf("[http] POST %s -> %d (%u bytes)\n", rota, code, fb->len);
  if (code == 401) Serial.println("[http] 401: chave recusada. Gere outra em Configuracoes > Placas e grave pelo portal");
  else if (code != 200) Serial.println("[http] sem reenvio: a proxima vem em 30 min");
  http.end();
  return code == 200;
}

bool enviaFoto(camera_fb_t *fb, time_t capturadaEm) {
  return enviaJpeg("/device/foto", fb, capturadaEm);
}

/* ------------------------------------------------------ quadro de luz
   cam-2.1.0. LUZ_ANTES_S antes de cada janela de foto (:59:40 e :29:40), a
   luz de cultivo ja esta APAGADA (main-1.5.0 apaga 30 s antes): o quadro mede so
   a luz natural. Um quadro SEM flash e com a exposicao TRAVADA vai para
   POST /device/luz. Travada porque, no automatico, o sensor clareia uma cena
   escura sozinho e esconderia a falta de luz; travada, quadro escuro = pouca
   luz de verdade. A IA recebe esse quadro junto com a foto seguinte e diz
   pouca/boa/muita luz -- na MESMA chamada, sem gastar IA a mais.
   Ao vivo, foto da IA e WebSocket nao mudam: o sensor volta ao automatico
   logo depois. */
const int LUZ_ANTES_S = 20;
const int LUZ_AEC     = 300;   // exposicao fixa do quadro de luz (0-1200)
long ultimoCicloLuz = -1;      // qual janela ja teve o seu quadro de luz

void cuidaQuadroLuz() {
  if (!getLocalTime(&tmAgora, 0)) return;
  const int CICLO_S = FOTO_INTERVALO_MIN * 60;
  int seg = segNoCicloFoto(tmAgora.tm_min, tmAgora.tm_sec);
  if (seg < CICLO_S - LUZ_ANTES_S || seg > CICLO_S - 8) return;

  // O quadro e da PROXIMA janela (a que comeca em segundos).
  long proxima = ((long)tmAgora.tm_yday * 24 * 60 + tmAgora.tm_hour * 60 + tmAgora.tm_min) / FOTO_INTERVALO_MIN + 1;
  if (proxima == ultimoCicloLuz) return;
  ultimoCicloLuz = proxima;

  Serial.println("[luz] quadro de iluminacao (sem flash, exposicao travada)");
  sensor_t *s = esp_camera_sensor_get();
  modoFoto();
  if (s) {
    s->set_exposure_ctrl(s, 0);
    s->set_aec2(s, 0);
    s->set_aec_value(s, LUZ_AEC);
    s->set_gain_ctrl(s, 0);
    s->set_agc_gain(s, 0);
  }
  delay(200);
  descartaQuadros(3);            // os que ainda vieram com a exposicao antiga
  time_t capturadoEm;
  time(&capturadoEm);
  camera_fb_t *fb = esp_camera_fb_get();

  // De volta ao automatico antes de qualquer outra coisa (ao vivo, foto).
  if (s) {
    s->set_exposure_ctrl(s, 1);
    s->set_gain_ctrl(s, 1);
  }
  if (!fb) {
    Serial.println("[luz] captura falhou");
  } else {
    enviaJpeg("/device/luz", fb, capturadoEm);
    esp_camera_fb_return(fb);
  }
  modoAoVivo();
  descartaQuadros(2);
}

/* Na janela combinada (:00 e :30, FOTO_OFFSET_S segundos depois do inicio,
   quando o ESP32 principal ja apagou a luz roxa), uma foto com flash. Cada
   janela e atendida uma vez so (ultimoCicloFoto). */
void cuidaFotoAgendada() {
  if (!getLocalTime(&tmAgora, 0)) return;
  int seg = segNoCicloFoto(tmAgora.tm_min, tmAgora.tm_sec);
  if (seg < FOTO_OFFSET_S || seg > FOTO_JANELA_S - 5) return;

  long ciclo = ((long)tmAgora.tm_yday * 24 * 60 + tmAgora.tm_hour * 60 + tmAgora.tm_min) / FOTO_INTERVALO_MIN;
  if (ciclo == ultimoCicloFoto) return;
  ultimoCicloFoto = ciclo;

  Serial.printf("[foto] janela %02d:%02d, foto para a IA\n", tmAgora.tm_hour, tmAgora.tm_min);
  modoFoto();
  descartaQuadros(2);
  time_t capturadaEm;
  time(&capturadaEm);                 // epoch UTC
  camera_fb_t *fb = capturaComFlash();
  if (!fb) {
    Serial.println("[cam] captura falhou");
  } else {
    Serial.printf("[cam] %u bytes\n", fb->len);
    bool ok = enviaFoto(fb, capturadaEm);
    esp_camera_fb_return(fb);
    if (ok && !aoVivo) pisca(1, 800);
  }
  modoAoVivo();
  descartaQuadros(2);
}

// ------------------------------------------------------------- ao vivo
void eventoWs(WStype_t tipo, uint8_t *dados, size_t tam) {
  switch (tipo) {
    case WStype_CONNECTED:
      Serial.println("[ws] conectado ao backend, esperando pedido de ao vivo");
      break;
    case WStype_DISCONNECTED:
      if (aoVivo) Serial.println("[ws] caiu: ao vivo parado");
      aoVivo = false;
      break;
    case WStype_TEXT: {
      JsonDocument doc;
      if (deserializeJson(doc, dados, tam)) return;
      if (doc["tipo"] == "portal") {
        Serial.println("[portal] o app pediu para trocar a rede Wi-Fi");
        pedidoPortal = true;
        break;
      }
      if (doc["tipo"] == "ao_vivo") {
        bool ligar = doc["ligar"] | false;
        if (ligar != aoVivo) Serial.printf("[ao vivo] %s\n", ligar ? "alguem esta assistindo" : "ninguem assistindo");
        aoVivo = ligar;
        if (ligar) {
          aoVivoAte = millis() + AO_VIVO_PRAZO_MS;
          led(false);
        }
      }
      break;
    }
    default:
      break;
  }
}

/* https://host[:porta]/api -> conecta em wss://host[:porta]/ws, com a chave
   no cabecalho (o mesmo X-Device-Key do HTTP). */
void iniciaWs() {
  String u = cred.apiBase;
  bool ssl = u.startsWith("https://");
  u.remove(0, ssl ? 8 : 7);
  int barra = u.indexOf('/');
  String hostPorta = barra >= 0 ? u.substring(0, barra) : u;
  uint16_t porta = ssl ? 443 : 80;
  String host = hostPorta;
  int doisPontos = hostPorta.indexOf(':');
  if (doisPontos >= 0) {
    host = hostPorta.substring(0, doisPontos);
    porta = hostPorta.substring(doisPontos + 1).toInt();
  }

  cabecalhoChave = "X-Device-Key: " + cred.deviceKey;
  ws.setExtraHeaders(cabecalhoChave.c_str());
  ws.onEvent(eventoWs);
  ws.setReconnectInterval(5000);
  ws.enableHeartbeat(15000, 5000, 2);
  if (ssl) ws.beginSSL(host.c_str(), porta, "/ws");
  else     ws.begin(host.c_str(), porta, "/ws");
  Serial.printf("[ws] %s://%s:%u/ws\n", ssl ? "wss" : "ws", host.c_str(), porta);
}

void cuidaAoVivo() {
  if (aoVivo && (long)(millis() - aoVivoAte) >= 0) {
    // O backend parou de renovar (reiniciou, caiu): para por conta propria.
    Serial.println("[ao vivo] sem renovacao do backend, parando");
    aoVivo = false;
  }
  if (!aoVivo || !ws.isConnected()) return;
  if (millis() - tUltimoQuadro < QUADRO_MS) return;
  tUltimoQuadro = millis();

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) return;
  ws.sendBIN(fb->buf, fb->len);
  esp_camera_fb_return(fb);
}

// ------------------------------------------------------------- setup
void setup() {
  /* O detector de brownout fica LIGADO de proposito. Se a placa reiniciar com
     "Brownout detector was triggered", o problema e alimentacao (fonte fraca,
     fio fino, USB do PC). Ver README, secao Problemas comuns. */
  pinMode(PIN_FLASH, OUTPUT);
  digitalWrite(PIN_FLASH, LOW);
  pinMode(PIN_LED, OUTPUT);
  led(false);

  Serial.begin(115200);
  delay(200);
  Serial.println("\n== GrowAI " FW " ==");

  // Lido antes da camera: o reset duplo conta a partir de quando a placa liga.
  bool pediuPortal = resetDuplo();
  if (falhasWifi < 0 || falhasWifi > FALHAS_ATE_PORTAL) falhasWifi = 0;

  // ---- camera ----
  int tentativas = 0;
  while (!iniciaCamera()) {
    if (++tentativas >= 3) {
      Serial.println("[cam] 3 falhas seguidas: reiniciando em 60 s (confira o cabo flat)");
      delay(60000);
      ESP.restart();
    }
    delay(2000);
  }
  modoAoVivo();

  // ---- credenciais ----
  provisaoCarregar(cred, WIFI_SSID, WIFI_PASS, API_BASE, DEVICE_KEY);
  provisaoMostrar(cred);

  if (pediuPortal) {
    // Os campos ja vem preenchidos com o que esta gravado: so trocar a rede.
    abrePortal("reset duplo: trocar de rede");
  }
  if (!provisaoCompleta(cred)) abrePortal("sem credenciais gravadas");

  // ---- Wi-Fi ----
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);          // sleep do radio derruba a taxa do ao vivo
  bool conectou = conectaWifi(cred.ssid, cred.senha, WIFI_TIMEOUT_MS);

  /* Rede reserva: a do secrets.h (ex.: o roteador do celular), se for outra.
     Assim a placa nao fica orfa quando a rede gravada some. */
  String reserva = WIFI_SSID;
  if (!conectou && reserva.length() && reserva != cred.ssid) {
    Serial.printf("[wifi] tentando a rede reserva \"%s\"\n", WIFI_SSID);
    WiFi.disconnect(true);
    delay(100);
    WiFi.mode(WIFI_STA);
    conectou = conectaWifi(reserva, WIFI_PASS, WIFI_RESERVA_TIMEOUT_MS);
  }

  if (!conectou) {
    falhasWifi++;
    Serial.printf("[wifi] nao conectou (%d/%d)\n", falhasWifi, FALHAS_ATE_PORTAL);
    /* Insistiu e nao foi: provavelmente a rede mudou de nome ou de senha.
       Abre o portal para dar como consertar sem cabo nem computador. */
    if (falhasWifi >= FALHAS_ATE_PORTAL) {
      falhasWifi = 0;
      abrePortal("3 tentativas sem conseguir conectar");
    }
    delay(30000);
    ESP.restart();
  }
  falhasWifi = 0;
  WiFi.setAutoReconnect(true);
  Serial.printf("[wifi] %s em \"%s\"  rssi %d\n", WiFi.localIP().toString().c_str(),
                WiFi.SSID().c_str(), WiFi.RSSI());
  if (!janelaResetAberta) pisca(3, 150);

  configTzTime(TZ_SP, NTP1, NTP2);
  iniciaWs();
}

// ------------------------------------------------------------- loop
void loop() {
  cuidaJanelaReset();

  // Pedido do app: esquece a rede (a API e a chave ficam) e abre o portal.
  if (pedidoPortal) {
    pedidoPortal = false;
    aoVivo = false;
    ws.disconnect();
    provisaoEsquecerRede(cred);
    WiFi.disconnect();
    abrePortal("pedido pelo app: trocar a rede Wi-Fi");   // bloqueia e reinicia no fim
  }

  // Sem Wi-Fi por muito tempo: reinicia, e o boot decide se abre o portal.
  static unsigned long semRedeDesde = 0;
  if (WiFi.status() != WL_CONNECTED) {
    if (!semRedeDesde) semRedeDesde = millis();
    else if (millis() - semRedeDesde > WIFI_SEM_REDE_MAX_MS) {
      Serial.println("[wifi] 5 min sem rede, reiniciando");
      delay(200);
      ESP.restart();
    }
  } else {
    semRedeDesde = 0;
  }

  ws.loop();
  cuidaQuadroLuz();       // ~20 s antes da foto, com o LED apagado (luz natural)
  cuidaFotoAgendada();
  cuidaAoVivo();
  delay(5);
}
