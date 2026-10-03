/* GrowAI - ESP32-CAM (AI-Thinker)
   Uma foto a cada FOTO_INTERVALO_MIN minutos, dentro da janela em que o
   ESP32 principal apaga o LED Grow. Fora dessa janela a luz roxa falseia as
   cores e a analise de amarelamento pela IA vai por agua abaixo.

   O ciclo inteiro roda no setup(): acorda -> camera -> Wi-Fi -> NTP ->
   espera a janela -> flash -> captura -> envia -> deep sleep. loop() fica
   vazio, porque o deep sleep reinicia a placa do zero a cada ciclo.

   Esta placa nunca fala com a IA e nao guarda nenhuma chave de IA. */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <esp_camera.h>
#include <esp_sleep.h>
#include <time.h>
/* Preferences vem incluido aqui, e nao so dentro de shared/provisao.h, porque
   o resolvedor de bibliotecas do PlatformIO varre apenas src/ e include/ do
   projeto: um #include que exista somente no shared/ nao faz a biblioteca do
   core ser encontrada, e o build falha com "Preferences.h: No such file". */
#include <Preferences.h>

#include <WiFiManager.h>

#include "protocolo.h"
#include "provisao.h"
#include "secrets.h"

#define FW "cam-1.0.0"

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

const uint8_t PIN_FLASH = 4;      // LED branco da placa; forte, so na captura

const unsigned long WIFI_TIMEOUT_MS = 20000;
const unsigned long NTP_TIMEOUT_MS  = 8000;
const unsigned long FLASH_MAX_MS    = 2000;

/* Sobrevive ao deep sleep (nao ao reset/queda de energia). Conta as falhas
   seguidas de esp_camera_init para nao entrar em loop de restart. */
RTC_DATA_ATTR int falhasCam = 0;

/* Falhas seguidas de Wi-Fi, tambem no RTC. A CAM nao tem botao acessivel para
   pedir o portal (o GPIO 0 e o XCLK da camera), entao o gatilho dela e este:
   depois de FALHAS_ATE_PORTAL ciclos sem conseguir conectar, ela assume que a
   rede mudou e abre o portal sozinha. */
RTC_DATA_ATTR int falhasWifi = 0;
static const int FALHAS_ATE_PORTAL = 3;

struct tm tmAgora;

WiFiClient       clienteHttp;
WiFiClientSecure clienteHttps;

/* Wi-Fi, API_BASE e DEVICE_KEY vem da NVS (ver provisao.h); o secrets.h entra
   so como valor de fabrica. */
Credenciais cred;

bool ehHttps() { return cred.apiBase.startsWith("https"); }

// ------------------------------------------------------------- deep sleep
void dorme(long segundos) {
  if (segundos < 5) segundos = 5;
  digitalWrite(PIN_FLASH, LOW);
  Serial.printf("[sono] dormindo %ld s\n", segundos);
  Serial.flush();
  esp_sleep_enable_timer_wakeup((uint64_t)segundos * 1000000ULL);
  esp_deep_sleep_start();
}

// Segundos daqui ate o inicio da proxima janela de foto (precisa de hora valida).
long segAteProximaJanela() {
  return (long)FOTO_INTERVALO_MIN * 60 - segNoCicloFoto(tmAgora.tm_min, tmAgora.tm_sec);
}

void dormeAteProximaJanela() {
  if (!getLocalTime(&tmAgora, 0)) {           // sem hora: ritmo cego
    dorme((long)FOTO_INTERVALO_MIN * 60);
    return;
  }
  long s = segAteProximaJanela() - CAM_PRE_S;
  // Perto demais? Acordar agora nao daria tempo de conectar: pula uma janela.
  if (s < 10) s += (long)FOTO_INTERVALO_MIN * 60;
  dorme(s);
}

// Trava de seguranca: passou do orcamento de tempo acordada, dorme de qualquer jeito.
void checaOrcamento(const char* onde) {
  if (millis() < (unsigned long)CAM_MAX_ACORDADA_S * 1000UL) return;
  Serial.printf("[trava] %ld s acordada em '%s', desistindo deste ciclo\n",
                (long)(millis() / 1000), onde);
  dormeAteProximaJanela();
  return;                        // dorme() nao volta; explicito para nao confiar nisso
}

/* Portal de configuracao.
   Aqui ele PODE bloquear, ao contrario do que acontece na placa principal: a
   CAM nao controla bomba nem luz, entao nao ha nada rodando que o portal possa
   atrapalhar. O timeout evita que ela fique acordada para sempre esperando
   alguem que nunca vai conectar. */
void abrePortal(const char *motivo) {
  Serial.printf("\n[portal] %s\n", motivo);
  Serial.printf("[portal] conecte-se a rede \"%s\" (senha %s)\n", PORTAL_SSID, PORTAL_SENHA);

  digitalWrite(PIN_FLASH, LOW);  // garante o flash apagado durante a espera

  WiFiManager wm;
  WiFiManagerParameter pApi("api", "Endereco da API", cred.apiBase.c_str(), 120);
  WiFiManagerParameter pKey("key", "Chave desta placa (cam)", cred.deviceKey.c_str(), 96);
  wm.addParameter(&pApi);
  wm.addParameter(&pKey);
  wm.setConfigPortalTimeout(PORTAL_TIMEOUT_S);
  wm.setTitle("GrowAI - camera");

  bool ok = wm.startConfigPortal(PORTAL_SSID, PORTAL_SENHA);
  if (!ok) {
    Serial.println("[portal] ninguem configurou dentro do tempo; dormindo");
    dorme((long)FOTO_INTERVALO_MIN * 60);
    return;
  }

  cred.ssid      = WiFi.SSID();
  cred.senha     = WiFi.psk();
  cred.apiBase   = provisaoNormalizaUrl(String(pApi.getValue()));
  cred.deviceKey = String(pKey.getValue());
  cred.deviceKey.trim();
  provisaoSalvar(cred);
  Serial.println("[portal] credenciais salvas na NVS, reiniciando...");
  provisaoMostrar(cred);
  delay(400);
  ESP.restart();
}

// ---------------------------------------------------------------- camera
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
    s->set_whitebal(s, 1);   // AWB e AEC automaticos: a luz da janela varia
    s->set_awb_gain(s, 1);
    s->set_exposure_ctrl(s, 1);
    s->set_gain_ctrl(s, 1);
    s->set_vflip(s, 0);
    s->set_hmirror(s, 0);
  }
  return true;
}

// ------------------------------------------------------------- envio
bool enviaFoto(camera_fb_t *fb, time_t capturadaEm) {
  HTTPClient http;
  String url = cred.apiBase + "/device/foto";
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
  Serial.printf("[http] POST /device/foto -> %d (%u bytes)\n", code, fb->len);
  if (code != 200) Serial.println("[http] sem reenvio: a proxima foto vem em minutos");
  http.end();
  return code == 200;
}

// ------------------------------------------------------------- captura
camera_fb_t* capturaComFlash() {
  digitalWrite(PIN_FLASH, HIGH);
  unsigned long tFlash = millis();

  // Descarta 2 frames: os primeiros saem escuros, antes do AWB/AEC reagirem ao flash.
  for (int i = 0; i < 2; i++) {
    camera_fb_t *lixo = esp_camera_fb_get();
    if (lixo) esp_camera_fb_return(lixo);
  }
  camera_fb_t *fb = esp_camera_fb_get();

  digitalWrite(PIN_FLASH, LOW);
  unsigned long dur = millis() - tFlash;
  if (dur > FLASH_MAX_MS) Serial.printf("[cam] AVISO: flash ficou %lu ms aceso\n", dur);
  return fb;
}

// ------------------------------------------------------------- setup
void setup() {
  /* O detector de brownout fica LIGADO de proposito. Se a placa reiniciar com
     "Brownout detector was triggered", o problema e alimentacao (fonte fraca,
     fio fino, USB do PC) e se resolve no hardware, nao desligando o aviso.
     Ver README, secao Problemas comuns. */

  pinMode(PIN_FLASH, OUTPUT);
  digitalWrite(PIN_FLASH, LOW);

  Serial.begin(115200);
  delay(200);
  Serial.println("\n== GrowAI " FW " ==");

  // ---- camera ----
  if (!iniciaCamera()) {
    falhasCam++;
    if (falhasCam >= 3) {
      Serial.println("[cam] 3 falhas seguidas: desistindo deste ciclo");
      falhasCam = 0;
      dorme((long)FOTO_INTERVALO_MIN * 60);
      return;
    }
    Serial.printf("[cam] falha %d/3, reiniciando em 5 s\n", falhasCam);
    delay(5000);
    ESP.restart();
  }
  falhasCam = 0;

  // ---- credenciais ----
  provisaoCarregar(cred, WIFI_SSID, WIFI_PASS, API_BASE, DEVICE_KEY);
  provisaoMostrar(cred);

  if (!provisaoCompleta(cred)) {
    abrePortal("sem credenciais gravadas");
    return;  // abrePortal() sempre termina em restart ou deep sleep
  }

  // ---- Wi-Fi ----
  WiFi.mode(WIFI_STA);
  WiFi.begin(cred.ssid.c_str(), cred.senha.c_str());
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_TIMEOUT_MS) delay(200);
  if (WiFi.status() != WL_CONNECTED) {
    falhasWifi++;
    Serial.printf("[wifi] nao conectou (%d/%d)\n", falhasWifi, FALHAS_ATE_PORTAL);
    /* Insistiu e nao foi: provavelmente a rede mudou de nome ou de senha.
       Abre o portal para dar como consertar sem cabo nem computador. */
    if (falhasWifi >= FALHAS_ATE_PORTAL) {
      falhasWifi = 0;
      abrePortal("3 ciclos sem conseguir conectar");
      return;
    }
    dormeAteProximaJanela();
    return;
  }
  falhasWifi = 0;
  Serial.printf("[wifi] %s  rssi %d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());

  // ---- NTP ----
  configTzTime(TZ_SP, NTP1, NTP2);
  bool horaValida = false;
  t0 = millis();
  while (millis() - t0 < NTP_TIMEOUT_MS) {
    if (getLocalTime(&tmAgora, 200)) { horaValida = true; break; }
  }

  camera_fb_t *fb = nullptr;
  time_t capturadaEm = 0;

  if (!horaValida) {
    // Sem hora nao da para saber se a luz roxa esta apagada. Fotografa mesmo
    // assim e deixa o backend decidir o que fazer com uma foto sem timestamp.
    Serial.println("[ntp] falhou: foto agora, X-Captured-At: 0");
    fb = capturaComFlash();
  } else {
    Serial.printf("[ntp] %04d-%02d-%02d %02d:%02d:%02d\n",
                  tmAgora.tm_year + 1900, tmAgora.tm_mon + 1, tmAgora.tm_mday,
                  tmAgora.tm_hour, tmAgora.tm_min, tmAgora.tm_sec);

    int seg = segNoCicloFoto(tmAgora.tm_min, tmAgora.tm_sec);
    if (seg > FOTO_JANELA_S) {
      // Chegamos depois da janela: a luz roxa ja voltou. Foto agora sairia com
      // a cor errada, entao e melhor esperar a proxima.
      Serial.printf("[janela] perdida (%d s no ciclo), esperando a proxima\n", seg);
      dormeAteProximaJanela();
      return;
    }

    long espera = (long)FOTO_OFFSET_S - seg;
    if (espera > 0) {
      Serial.printf("[janela] esperando %ld s para a luz apagar\n", espera);
      unsigned long alvo = millis() + (unsigned long)espera * 1000UL;
      while ((long)(millis() - alvo) < 0) { delay(100); checaOrcamento("espera da janela"); }
    }

    checaOrcamento("antes da captura");
    time(&capturadaEm);                 // epoch UTC
    fb = capturaComFlash();
  }

  if (!fb) {
    Serial.println("[cam] captura falhou");
    dormeAteProximaJanela();
    return;                      // sem isto, o fb->len abaixo seria deref de null
  }

  Serial.printf("[cam] %u bytes\n", fb->len);
  enviaFoto(fb, capturadaEm);
  esp_camera_fb_return(fb);

  if (horaValida) dormeAteProximaJanela();
  else            dorme((long)FOTO_INTERVALO_MIN * 60);
}

void loop() { /* nunca chega aqui: o setup() sempre termina em deep sleep */ }
