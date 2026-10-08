/* GrowAI - ESP32 principal
   Irrigacao + fotoperiodo + ventilacao + nutrientes.

   O controle e SEMPRE local: histerese, MAX_BOMBA, ABSORCAO, corte por sensor
   invalido e limite diario de nutriente funcionam sem Wi-Fi. O backend so
   ajusta parametros, e todo parametro passa por valida() antes de valer.

   Serial: 115200. Calibre AR/AGUA com o `umidade_bruto` impresso. */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <esp_task_wdt.h>
#include <time.h>

#include <WiFiManager.h>

#include "protocolo.h"
#include "provisao.h"
#include "secrets.h"

#define FW "main-1.0.0"

// ---------------------------------------------------------------- pinos
const uint8_t PIN_SENSOR  = 34;  // ADC1: le com o Wi-Fi ligado (ADC2 nao le)
const uint8_t PIN_DS18B20 = 25;  // OneWire escreve no pino: nao pode ser 34-39
const uint8_t PIN_BOMBA   = 26;
const uint8_t PIN_LUZ     = 27;
const uint8_t PIN_VENT    = 14;  // solta PWM no boot, antes do setup(): ver README
const uint8_t PIN_NUTRI   = 32;
/* Botao BOOT da DevKit. Segurar ao ligar abre o portal de configuracao, que e
   como se troca de rede sem computador. Depois do boot ele e uma entrada
   comum, entao nao atrapalha nada. */
const uint8_t PIN_BOOT    = 0;

const bool RELE_ATIVO_BAIXO = false;   // este modulo aciona em HIGH

// ------------------------------------------------- calibracao do sensor
const int AR = 3200, AGUA = 1350;            // seco no ar / dentro d'agua
const int BRUTO_MIN = 500, BRUTO_MAX = 4000; // fora disso: solto ou em curto

// ------------------------------------- limites duros (comando nao fura)
/* O sensor fica enterrado perto da ENTRADA da agua: ele molha primeiro,
   enquanto a ultima saida do cano ainda esta seca. Se o corte por umidade
   valesse desde o primeiro segundo, a bomba desligaria com o cano pela metade,
   o sensor leria 60%, o firmware acharia que regou -- e a ponta final nunca
   receberia nada. Pior: a cada ABSORCAO o cano escorre de volta, e o ciclo
   seguinte comeca do zero.

   Por isso REGA_MIN: o tempo minimo ligada, em que a umidade NAO desliga a
   bomba. Ele tem que cobrir as duas fases, porque quando o cano acaba de
   encher o sensor JA esta molhado -- se o minimo parasse no enchimento, a
   histerese cortaria na mesma hora e a dose nunca sairia:

     REGA_ENCHE   enchendo o cano, a agua ainda nao chegou na planta  (MEDIR)
     REGA_DOSE    regando de verdade, com o cano cheio

   Passado o REGA_MIN, quem manda em desligar volta a ser o sensor. O teto duro
   da a ele mais uma dose de margem e corta: no pior caso a planta recebe o
   DOBRO da dose, nunca mais que isso.

   MEDIR o seu REGA_ENCHE: README secao 3.1. Enquanto nao medir, o valor abaixo
   e so um ponto de partida. */
const unsigned long REGA_ENCHE    = 20000;   // enchimento dos canos (MEDIR)
const unsigned long REGA_DOSE     = 15000;   // rega de verdade, cano ja cheio
const unsigned long REGA_MIN      = REGA_ENCHE + REGA_DOSE;      // sensor nao corta antes
const unsigned long MAX_BOMBA     = REGA_ENCHE + 2 * REGA_DOSE;  // teto por acionamento
const unsigned long ABSORCAO      = 300000;  // 5 min de pausa
const unsigned long NUTRI_MAX_MS  = 30000;   // nutriente: 30 s por dia
const int  DUR_MANUAL_MAX_S = 3600;
const int  NUTRI_JANELA_MIN = 10;   // atraso tolerado para a dose do dia
const int  WDT_S = 30;
const int  PORTAL_BOTAO_S = 10;     // janela para apertar BOOT e abrir o portal

/* Conferidos pelo compilador: mexer nos tempos de rega e quebrar uma destas
   regras FALHA o build, em vez de gerar um firmware que afoga a planta ou que
   corta a bomba antes de o cano encher. */
static_assert(REGA_MIN < MAX_BOMBA,
              "o teto duro cortaria a bomba antes de a dose do ciclo terminar");
static_assert(MAX_BOMBA <= 120000,
              "bomba acima de 2 min por acionamento: confira REGA_ENCHE/REGA_DOSE");

// ---------------------------------------------------------------- reles
enum { R_BOMBA, R_NUTRI, R_LUZ, R_VENT, N_RELES };
const char*   NOME_RELE[N_RELES] = { "bomba", "nutri", "luz", "vent" };
const uint8_t PINO_RELE[N_RELES] = { PIN_BOMBA, PIN_NUTRI, PIN_LUZ, PIN_VENT };

bool          ligado[N_RELES]    = { false, false, false, false };
bool          manual[N_RELES]    = { false, false, false, false };
unsigned long manualFim[N_RELES] = { 0, 0, 0, 0 };   // prazo em millis()

void rele(uint8_t p, bool on) {
  digitalWrite(p, (RELE_ATIVO_BAIXO ? !on : on) ? HIGH : LOW);
}

// -------------------------------------------------------------- config
struct Config {
  int      umid_liga, umid_desliga;
  int      luz_on, luz_off;     // minutos desde a meia-noite
  int      vent_min_por_hora;
  float    temp_max;
  int      nutri_hora;          // minutos desde a meia-noite
  int      nutri_s;
  uint32_t cfg_versao;
};
Config cfg = { 40, 60, 6 * 60, 18 * 60, 10, 30.0f, 8 * 60, 8, 0 };  // fabrica

Preferences nvs;
String erroCfg = "";

/* Wi-Fi, API_BASE e DEVICE_KEY vem da NVS, nao do codigo (ver provisao.h).
   O secrets.h entra so como valor de fabrica, quando a NVS esta vazia. */
Credenciais cred;
WiFiManager wm;
WiFiManagerParameter pApi("api", "Endereco da API", "", 120);
WiFiManagerParameter pKey("key", "Chave desta placa (main)", "", 96);
bool portalAtivo = false;

// -------------------------------------------------------------- estado
enum { MONITORANDO, REGANDO, ABSORVENDO };
const char* NOME_ESTADO[] = { "MONITORANDO", "REGANDO", "ABSORVENDO" };
uint8_t       estado = MONITORANDO;
unsigned long tEstado = 0;

int   umidade = -1, umidadeBruto = 0;     // umidade -1 = invalida
float tempC = NAN;
bool  tempOk = false;
String erro = "";

OneWire ow(PIN_DS18B20);
DallasTemperature ds(&ow);
bool dsPedido = false;
unsigned long tDsPedido = 0;
const unsigned long DS_CONVERSAO_MS = 800;   // 12 bits: 750 ms + folga

unsigned long bombaLigadaEm = 0;
unsigned long nutriMsHoje = 0, nutriFim = 0;
bool nutriDosando = false, nutriFeitoHoje = false;
bool ventPorTemp = false;
int  diaDoAno = -1;

bool horaValida = false;
struct tm tmAgora;

// -------------------------------------------------------------- horas
bool parseHora(const char* s, int &out) {
  int h, m;
  if (!s || sscanf(s, "%d:%d", &h, &m) != 2) return false;
  if (h < 0 || h > 23 || m < 0 || m > 59) return false;
  out = h * 60 + m;
  return true;
}
String fmtHora(int min) {
  // Os % deixam claro (para o compilador e para quem le) que cada campo tem
  // 2 digitos. valida() ja garante 0..1439, isto e so cinto de seguranca.
  int h = (min / 60) % 24, m = (min % 60 + 60) % 60;
  if (h < 0) h += 24;
  char b[6];
  snprintf(b, sizeof b, "%02d:%02d", h, m);
  return String(b);
}

bool dentroFotoperiodo(int minutos) {
  if (cfg.luz_on == cfg.luz_off) return true;                        // 24 h aceso
  if (cfg.luz_on <  cfg.luz_off) return minutos >= cfg.luz_on && minutos < cfg.luz_off;
  return minutos >= cfg.luz_on || minutos < cfg.luz_off;             // cruza meia-noite
}

// ------------------------------------------------------ config em NVS
void carregaCfg() {
  nvs.begin("growai", true);
  if (nvs.isKey("v")) {
    cfg.umid_liga         = nvs.getInt("ul", cfg.umid_liga);
    cfg.umid_desliga      = nvs.getInt("ud", cfg.umid_desliga);
    cfg.luz_on            = nvs.getInt("lo", cfg.luz_on);
    cfg.luz_off           = nvs.getInt("lf", cfg.luz_off);
    cfg.vent_min_por_hora = nvs.getInt("vm", cfg.vent_min_por_hora);
    cfg.temp_max          = nvs.getFloat("tm", cfg.temp_max);
    cfg.nutri_hora        = nvs.getInt("nh", cfg.nutri_hora);
    cfg.nutri_s           = nvs.getInt("ns", cfg.nutri_s);
    cfg.cfg_versao        = nvs.getUInt("v", cfg.cfg_versao);
    Serial.println("[cfg] carregada da NVS");
  } else {
    Serial.println("[cfg] NVS vazia, usando padrao de fabrica");
  }
  nvs.end();
}

void salvaCfg() {
  nvs.begin("growai", false);
  nvs.putInt("ul", cfg.umid_liga);
  nvs.putInt("ud", cfg.umid_desliga);
  nvs.putInt("lo", cfg.luz_on);
  nvs.putInt("lf", cfg.luz_off);
  nvs.putInt("vm", cfg.vent_min_por_hora);
  nvs.putFloat("tm", cfg.temp_max);
  nvs.putInt("nh", cfg.nutri_hora);
  nvs.putInt("ns", cfg.nutri_s);
  nvs.putUInt("v", cfg.cfg_versao);
  nvs.end();
}

bool valida(const Config &c, String &err) {
  if (c.umid_liga < 15 || c.umid_liga > 80)  { err = "umid_liga fora de 15..80"; return false; }
  if (c.umid_desliga > 95)                   { err = "umid_desliga acima de 95"; return false; }
  if (c.umid_desliga < c.umid_liga + 5)      { err = "umid_desliga precisa ser >= umid_liga+5"; return false; }
  if (c.luz_on  < 0 || c.luz_on  > 1439)     { err = "luz_on invalido"; return false; }
  if (c.luz_off < 0 || c.luz_off > 1439)     { err = "luz_off invalido"; return false; }
  if (c.nutri_hora < 0 || c.nutri_hora > 1439) { err = "nutri_hora invalido"; return false; }
  if (c.vent_min_por_hora < 0 || c.vent_min_por_hora > 60) { err = "vent_min_por_hora fora de 0..60"; return false; }
  if (isnan(c.temp_max) || c.temp_max < 15 || c.temp_max > 45) { err = "temp_max fora de 15..45"; return false; }
  if (c.nutri_s < 0 || c.nutri_s > 30)       { err = "nutri_s fora de 0..30"; return false; }
  return true;
}

void mostraCfg() {
  Serial.printf("[cfg] v%u  umid %d/%d  luz %s-%s  vent %d min/h  temp_max %.1f  nutri %s x%d s\n",
                cfg.cfg_versao, cfg.umid_liga, cfg.umid_desliga,
                fmtHora(cfg.luz_on).c_str(), fmtHora(cfg.luz_off).c_str(),
                cfg.vent_min_por_hora, cfg.temp_max,
                fmtHora(cfg.nutri_hora).c_str(), cfg.nutri_s);
}

// ---------------------------------------------------- comandos manuais
const int MAX_IDS = 16;
long idsVistos[MAX_IDS]; int nIdsVistos = 0;   // anti-repeticao
long acks[MAX_IDS];      int nAcks = 0;        // vao na proxima telemetria

bool jaVisto(long id) {
  for (int i = 0; i < nIdsVistos; i++) if (idsVistos[i] == id) return true;
  return false;
}
void marcaVisto(long id) {
  if (nIdsVistos < MAX_IDS) idsVistos[nIdsVistos++] = id;
  else {                                       // fila circular: descarta o mais antigo
    memmove(idsVistos, idsVistos + 1, sizeof(long) * (MAX_IDS - 1));
    idsVistos[MAX_IDS - 1] = id;
  }
}
void addAck(long id) { if (nAcks < MAX_IDS) acks[nAcks++] = id; }

void executaComando(JsonObjectConst c, unsigned long agora) {
  long id = c["id"] | -1L;
  const char* nome = c["rele"] | "";
  const char* acao = c["acao"] | "";
  if (id < 0 || !*nome || !*acao) return;
  if (jaVisto(id)) { addAck(id); return; }      // reack: o servidor perdeu o anterior

  int idx = -1;
  for (int i = 0; i < N_RELES; i++) if (!strcmp(nome, NOME_RELE[i])) idx = i;

  if (idx < 0) {
    Serial.printf("[cmd %ld] rele '%s' desconhecido\n", id, nome);
  } else if (!strcmp(acao, "desligar")) {
    manual[idx] = false;                        // encerra a sobreposicao: volta ao automatico
    Serial.printf("[cmd %ld] %s volta ao automatico\n", id, nome);
  } else if (!strcmp(acao, "ligar")) {
    long dur = c["dur_s"] | 0L;
    if (dur <= 0) dur = 60;
    if (dur > DUR_MANUAL_MAX_S) dur = DUR_MANUAL_MAX_S;
    if (idx == R_BOMBA && dur > (long)(MAX_BOMBA / 1000)) dur = MAX_BOMBA / 1000;
    if (idx == R_NUTRI) {                       // o manual tambem cabe no limite do dia
      long resta = (long)((NUTRI_MAX_MS - (nutriMsHoje > NUTRI_MAX_MS ? NUTRI_MAX_MS : nutriMsHoje)) / 1000);
      if (dur > resta) dur = resta;
    }
    if (dur <= 0) {
      Serial.printf("[cmd %ld] %s sem margem no limite, ignorado\n", id, nome);
    } else {
      manual[idx] = true;
      manualFim[idx] = agora + (unsigned long)dur * 1000UL;
      Serial.printf("[cmd %ld] %s ligado por %ld s\n", id, nome, dur);
    }
  } else {
    Serial.printf("[cmd %ld] acao '%s' desconhecida\n", id, acao);
  }

  marcaVisto(id);
  addAck(id);                                   // ack mesmo se recusado: nao reenviar
}

void expiraManuais(unsigned long agora) {
  for (int i = 0; i < N_RELES; i++)
    if (manual[i] && (long)(agora - manualFim[i]) >= 0) {
      manual[i] = false;
      Serial.printf("[manual] %s expirou, volta ao automatico\n", NOME_RELE[i]);
    }
}

// -------------------------------------------------------------- sensores
void leSensores(unsigned long agora) {
  long soma = 0;
  for (int i = 0; i < 10; i++) { soma += analogRead(PIN_SENSOR); delay(5); }
  umidadeBruto = soma / 10;
  umidade = (umidadeBruto < BRUTO_MIN || umidadeBruto > BRUTO_MAX)
            ? -1 : constrain(map(umidadeBruto, AR, AGUA, 0, 100), 0, 100);

  // DS18B20 nao bloqueante: pede numa passada, le na seguinte
  if (!dsPedido) {
    ds.requestTemperatures();
    dsPedido = true;
    tDsPedido = agora;
  } else if ((unsigned long)(agora - tDsPedido) >= DS_CONVERSAO_MS) {
    float t = ds.getTempCByIndex(0);
    // -127 = nada no barramento; 85,0 = valor de reset do chip (nunca real aqui)
    tempOk = !(isnan(t) || t <= -100.0f || t == 85.0f);
    tempC = tempOk ? t : NAN;
    dsPedido = false;
  }

  // maquina de estados da irrigacao
  if (umidade < 0) {
    estado = MONITORANDO;                       // bomba cai em atualizaCargas()
    erro = "sensor de umidade invalido (GPIO 34)";
  } else {
    erro = tempOk ? "" : "DS18B20 sem leitura (GPIO 25)";
    if (estado == MONITORANDO && umidade < cfg.umid_liga) {
      estado = REGANDO; tEstado = agora;
    } else if (estado == REGANDO && umidade >= cfg.umid_desliga
               && (unsigned long)(agora - tEstado) >= REGA_MIN) {
      /* A umidade so manda desligar DEPOIS de REGA_MIN. Antes disso o sensor
         esta medindo a agua que acabou de passar por ele, nao a que chegou na
         planta. Quem garante que a bomba nao fica ligada para sempre nesse
         trecho e o MAX_BOMBA, la em atualizaCargas(). */
      estado = ABSORVENDO; tEstado = agora;
    }
  }
  if (estado == ABSORVENDO && (unsigned long)(agora - tEstado) >= ABSORCAO) {
    estado = MONITORANDO; tEstado = agora;
  }
}

// ----------------------------------------------------------- cargas
void viraDia() {
  if (!horaValida) return;
  if (diaDoAno == tmAgora.tm_yday) return;
  if (diaDoAno >= 0) {
    nutriMsHoje = 0;
    nutriFeitoHoje = false;
    Serial.println("[dia] virou: contador de nutriente zerado");
  }
  diaDoAno = tmAgora.tm_yday;
}

void atualizaCargas(unsigned long agora) {
  bool quer[N_RELES];
  int minutos = horaValida ? tmAgora.tm_hour * 60 + tmAgora.tm_min : 0;

  // ---- automatico ----
  quer[R_BOMBA] = (estado == REGANDO);

  // Sem hora ainda? Luz ACESA: perder a foto e melhor que perder a planta.
  quer[R_LUZ] = !horaValida
                || (dentroFotoperiodo(minutos) && !naJanelaFoto(tmAgora.tm_min, tmAgora.tm_sec));

  // ventiladores: N min no inicio de cada hora, ou temperatura alta (1 C de histerese)
  bool ventPorHora = horaValida && tmAgora.tm_min < cfg.vent_min_por_hora;
  if (tempOk) {
    if (!ventPorTemp && tempC > cfg.temp_max)            ventPorTemp = true;
    else if (ventPorTemp && tempC <= cfg.temp_max - 1.0f) ventPorTemp = false;
  } else {
    ventPorTemp = false;      // sem temperatura confiavel, so o ciclo por hora
  }
  quer[R_VENT] = ventPorHora || ventPorTemp;

  // nutrientes: uma dose por dia, no horario, com a bomba d'agua parada
  if (horaValida && !nutriFeitoHoje && !nutriDosando && cfg.nutri_s > 0
      && minutos >= cfg.nutri_hora && minutos < cfg.nutri_hora + NUTRI_JANELA_MIN
      && !ligado[R_BOMBA]) {
    nutriDosando = true;
    nutriFeitoHoje = true;
    nutriFim = agora + (unsigned long)cfg.nutri_s * 1000UL;
    Serial.printf("[nutri] dose do dia: %d s\n", cfg.nutri_s);
  }
  if (nutriDosando && (long)(agora - nutriFim) >= 0) nutriDosando = false;
  quer[R_NUTRI] = nutriDosando;

  // ---- sobreposicao manual ----
  for (int i = 0; i < N_RELES; i++) if (manual[i]) quer[i] = true;

  // ---- limites duros: valem para automatico E manual ----
  if (umidade < 0) quer[R_BOMBA] = false;
  if (ligado[R_BOMBA] && (unsigned long)(agora - bombaLigadaEm) >= MAX_BOMBA) {
    quer[R_BOMBA] = false;
    manual[R_BOMBA] = false;
    if (estado == REGANDO) { estado = ABSORVENDO; tEstado = agora; }
  }
  if (nutriMsHoje >= NUTRI_MAX_MS) { quer[R_NUTRI] = false; nutriDosando = false; }

  // ---- escreve so o que mudou ----
  for (int i = 0; i < N_RELES; i++) {
    if (quer[i] == ligado[i]) continue;
    ligado[i] = quer[i];
    rele(PINO_RELE[i], quer[i]);
    if (i == R_BOMBA && quer[i]) bombaLigadaEm = agora;
  }

  // contabiliza o nutriente gasto hoje
  static unsigned long tickNutri = 0;
  if (ligado[R_NUTRI]) {
    if (tickNutri) nutriMsHoje += agora - tickNutri;
    tickNutri = agora;
  } else tickNutri = 0;
}

// ----------------------------------------------------------- rede
WiFiClient       clienteHttp;
WiFiClientSecure clienteHttps;

unsigned long tWifi = 0, tTelemetria = 0;
int proximaEmS = 15, falhasSeguidas = 0;

bool ehHttps() { return cred.apiBase.startsWith("https"); }

/* Abre o portal SEM BLOQUEAR. Essa parte nao e detalhe: o metodo normal do
   WiFiManager trava dentro de um while ate alguem configurar, e isso pararia a
   irrigacao, a luz e a ventilacao pelo tempo que o portal ficasse aberto. Em
   modo nao bloqueante o loop() segue rodando normalmente e so chama
   wm.process() a cada volta. */
void abrePortal(const char *motivo) {
  if (portalAtivo) return;          // ja aberto: readicionar parametro duplica a tela
  Serial.printf("\n[portal] %s\n", motivo);
  Serial.printf("[portal] conecte-se a rede \"%s\" (senha %s)\n", PORTAL_SSID, PORTAL_SENHA);
  Serial.println("[portal] o controle local continua funcionando enquanto isso");

  pApi.setValue(cred.apiBase.c_str(), 120);
  pKey.setValue(cred.deviceKey.c_str(), 96);
  wm.addParameter(&pApi);
  wm.addParameter(&pKey);
  wm.setConfigPortalBlocking(false);
  wm.setConfigPortalTimeout(PORTAL_TIMEOUT_S);
  wm.setTitle("GrowAI - placa principal");
  wm.startConfigPortal(PORTAL_SSID, PORTAL_SENHA);
  portalAtivo = true;
}

/* Conectou pelo portal: guarda o que foi digitado e reinicia ja configurada.
   Le de WiFi.SSID()/psk() em vez dos callbacks do WiFiManager porque aqui a
   conexao ja aconteceu - nao depende de quando a biblioteca dispara o evento. */
void portalSalvaSeConectou() {
  if (!portalAtivo || WiFi.status() != WL_CONNECTED) return;
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

void cuidaWifi(unsigned long agora) {
  // Com o portal aberto quem cuida do radio e o WiFiManager.
  if (portalAtivo) return;
  if (!provisaoCompleta(cred)) return;   // nada gravado: nao ha rede para retentar
  if (WiFi.status() == WL_CONNECTED) return;
  if ((unsigned long)(agora - tWifi) < 10000) return;   // nao bloqueia: so retenta
  tWifi = agora;
  Serial.println("[wifi] reconectando...");
  WiFi.disconnect();
  WiFi.begin(cred.ssid.c_str(), cred.senha.c_str());
}

// Le uma hora "HH:MM" da config. Chave ausente = mantem a atual.
bool leHora(JsonObjectConst c, const char* k, int &dest, String &err) {
  if (c[k].isNull()) return true;
  if (!c[k].is<const char*>()) { err = String(k) + " precisa ser string HH:MM"; return false; }
  if (!parseHora(c[k].as<const char*>(), dest)) { err = String(k) + " invalido"; return false; }
  return true;
}

void trataResposta(const String &corpo) {
  JsonDocument doc;
  DeserializationError e = deserializeJson(doc, corpo);
  if (e) { Serial.printf("[http] resposta ilegivel: %s\n", e.c_str()); return; }

  // --- config nova (so vem quando a versao do servidor difere da nossa) ---
  if (doc["config"].is<JsonObjectConst>()) {
    JsonObjectConst c = doc["config"];
    Config nova = cfg;                       // parte da atual: campo ausente e mantido
    String err = "";

    nova.umid_liga         = c["umid_liga"]         | cfg.umid_liga;
    nova.umid_desliga      = c["umid_desliga"]      | cfg.umid_desliga;
    nova.vent_min_por_hora = c["vent_min_por_hora"] | cfg.vent_min_por_hora;
    nova.temp_max          = c["temp_max"]          | cfg.temp_max;
    nova.nutri_s           = c["nutri_s"]           | cfg.nutri_s;

    bool horasOk = leHora(c, "luz_on",     nova.luz_on,     err)
                && leHora(c, "luz_off",    nova.luz_off,    err)
                && leHora(c, "nutri_hora", nova.nutri_hora, err);

    if (!horasOk || !valida(nova, err)) {
      // Rejeita a config INTEIRA e mantem a versao antiga, para o servidor
      // reenviar depois de corrigir.
      erroCfg = err;
      Serial.printf("[cfg] RECUSADA: %s\n", err.c_str());
    } else {
      cfg = nova;
      cfg.cfg_versao = doc["cfg_versao"] | cfg.cfg_versao;
      erroCfg = "";
      salvaCfg();
      Serial.println("[cfg] aceita e salva na NVS");
      mostraCfg();
    }
  } else if (doc["cfg_versao"].is<unsigned int>()) {
    uint32_t v = doc["cfg_versao"].as<uint32_t>();
    // O servidor nao mandou config. Se ele concorda com a nossa versao, a
    // pendencia acabou: limpa o erro para nao ficar preso no site para sempre.
    if (v == cfg.cfg_versao) erroCfg = "";
    else if (erroCfg.length() == 0) cfg.cfg_versao = v;
  }

  // --- comandos manuais ---
  if (doc["comandos"].is<JsonArrayConst>()) {
    unsigned long agora = millis();
    for (JsonObjectConst c : doc["comandos"].as<JsonArrayConst>()) executaComando(c, agora);
  }

  // --- ritmo ---
  int p = doc["proxima_em_s"] | 15;
  proximaEmS = constrain(p, 5, 300);
}

void enviaTelemetria() {
  unsigned long agora = millis();

  JsonDocument doc;
  doc["fw"] = FW;
  doc["cfg_versao"] = cfg.cfg_versao;
  if (umidade >= 0) doc["umidade"] = umidade; else doc["umidade"] = nullptr;
  doc["umidade_bruto"] = umidadeBruto;
  if (tempOk) doc["temp_c"] = serialized(String(tempC, 1)); else doc["temp_c"] = nullptr;
  doc["estado"] = NOME_ESTADO[estado];

  JsonObject r = doc["reles"].to<JsonObject>();
  for (int i = 0; i < N_RELES; i++) r[NOME_RELE[i]] = ligado[i] ? 1 : 0;

  JsonObject m = doc["manual"].to<JsonObject>();
  for (int i = 0; i < N_RELES; i++) if (manual[i]) {
    long resta = (long)(manualFim[i] - agora) / 1000;
    m[NOME_RELE[i]] = resta > 0 ? resta : 0;
  }

  doc["nutri_s_hoje"] = (int)(nutriMsHoje / 1000);
  doc["hora_valida"]  = horaValida;
  doc["rssi"]         = WiFi.RSSI();
  doc["uptime_s"]     = (uint32_t)(agora / 1000);

  JsonArray a = doc["acks"].to<JsonArray>();
  for (int i = 0; i < nAcks; i++) a.add(acks[i]);

  if (erro.length())    doc["erro"]     = erro;    else doc["erro"]     = nullptr;
  if (erroCfg.length()) doc["erro_cfg"] = erroCfg; else doc["erro_cfg"] = nullptr;

  String corpo;
  serializeJson(doc, corpo);

  HTTPClient http;
  String url = cred.apiBase + "/device/telemetria";
  bool aberto;
  if (ehHttps()) {
    /* setInsecure(): NAO valida o certificado do servidor.
       O bundle de CAs do core precisa de board_build.embed_files +
       setCACertBundle(), custa ~64 kB de flash e quebra a cada troca de core.
       Risco aceito: um man-in-the-middle veria a telemetria e a DEVICE_KEY.
       A DEVICE_KEY nao da acesso a conta de nenhum usuario, so as duas rotas
       de dispositivo. Para producao de verdade, veja PROTOCOLO.md. */
    clienteHttps.setInsecure();
    aberto = http.begin(clienteHttps, url);
  } else {
    aberto = http.begin(clienteHttp, url);
  }
  if (!aberto) { Serial.println("[http] URL invalida, confira API_BASE"); return; }

  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", cred.deviceKey.c_str());

  /* Alimenta o watchdog agora. O POST bloqueia por ate connect(10 s) +
     leitura(10 s), e se ele comecar no fim da janela de 30 s do WDT a placa
     reiniciaria no meio de um envio que ia dar certo. */
  esp_task_wdt_reset();

  int code = http.POST(corpo);
  if (code == 200) {
    String resp = http.getString();
    http.end();
    nAcks = 0;                 // confirmados: o servidor recebeu
    falhasSeguidas = 0;
    trataResposta(resp);
  } else if (code == 401) {
    http.end();
    Serial.println("[http] 401 chave invalida, nova tentativa em 60 s");
    proximaEmS = 60;
  } else {
    http.end();
    falhasSeguidas++;
    proximaEmS = falhasSeguidas >= 3 ? 60 : (falhasSeguidas == 2 ? 30 : 15);
    Serial.printf("[http] falhou (%d), tentando em %d s, controle local segue\n",
                  code, proximaEmS);
  }
}

void cicloTelemetria(unsigned long agora) {
  if (portalAtivo || !provisaoCompleta(cred)) return;
  if (WiFi.status() != WL_CONNECTED) return;
  if ((unsigned long)(agora - tTelemetria) < (unsigned long)proximaEmS * 1000UL) return;

  /* O POST bloqueia por ate HTTP_TIMEOUT_MS. Com a bomba ou a minibomba
     ligada isso furaria o MAX_BOMBA / o limite diario, entao espera elas
     desligarem (no maximo 20 s) e manda no ciclo seguinte. */
  if (ligado[R_BOMBA] || ligado[R_NUTRI]) return;

  tTelemetria = agora;
  enviaTelemetria();
}

// ----------------------------------------------------------- setup/loop
void setup() {
  // pinMode + tudo desligado ANTES de qualquer outra coisa: evita o tec no boot
  for (int i = 0; i < N_RELES; i++) {
    pinMode(PINO_RELE[i], OUTPUT);
    rele(PINO_RELE[i], false);
  }

  Serial.begin(115200);
  delay(200);
  Serial.println("\n== GrowAI " FW " ==");

  analogReadResolution(12);
  analogSetPinAttenuation(PIN_SENSOR, ADC_11db);
  ds.begin();
  ds.setWaitForConversion(false);

  carregaCfg();
  mostraCfg();

  /* Credenciais: o que esta na NVS vence, e o secrets.h entra so como valor
     de fabrica (ver provisao.h). Sem este provisaoCarregar a placa tentava
     conectar nas strings VAZIAS do secrets.h: ela nunca achava a rede
     configurada pelo portal, e o cicloTelemetria morria no
     !provisaoCompleta(cred) -- nada chegava no app, para sempre. */
  provisaoCarregar(cred, WIFI_SSID, WIFI_PASS, API_BASE, DEVICE_KEY);
  provisaoMostrar(cred);

  pinMode(PIN_BOOT, INPUT_PULLUP);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  configTzTime(TZ_SP, NTP1, NTP2);

  if (provisaoCompleta(cred)) {
    WiFi.begin(cred.ssid.c_str(), cred.senha.c_str());
  } else {
    /* Nao bloqueia: o portal sobe e a irrigacao, a luz e a ventilacao
       continuam decidindo sozinhas enquanto alguem configura pelo celular. */
    abrePortal("sem credenciais gravadas");
  }

#if ESP_IDF_VERSION_MAJOR >= 5
  esp_task_wdt_config_t w = { .timeout_ms = (uint32_t)WDT_S * 1000,
                              .idle_core_mask = 0, .trigger_panic = true };
  esp_task_wdt_init(&w);
#else
  esp_task_wdt_init(WDT_S, true);
#endif
  esp_task_wdt_add(NULL);

  tEstado = millis();
}

void loop() {
  unsigned long agora = millis();
  esp_task_wdt_reset();

  /* Gatilho do portal nesta placa: APERTE o BOOT nos primeiros
     PORTAL_BOTAO_S segundos depois de ligar. Nao da para "segurar BOOT
     enquanto liga": com o GPIO 0 em GND no reset o ESP32 entra em modo de
     gravacao e o firmware nem chega a rodar. */
  if (!portalAtivo && agora < (unsigned long)PORTAL_BOTAO_S * 1000UL
      && digitalRead(PIN_BOOT) == LOW) {
    abrePortal("botao BOOT apertado no inicio");
  }

  /* O portal roda JUNTO com o controle local, nunca no lugar dele: a bomba, a
     luz e a ventilacao continuam decidindo sozinhas enquanto alguem configura
     a rede pelo celular. */
  if (portalAtivo) {
    wm.process();
    portalSalvaSeConectou();

    /* Portal fechou sozinho (ninguem configurou dentro do PORTAL_TIMEOUT_S).
       Sem isto a placa ficaria em modo ponto de acesso para sempre, sem nunca
       voltar a tentar a rede: o controle local seguiria funcionando, mas ela
       nunca mais apareceria no app. Reiniciar devolve ao fluxo normal. */
    if (portalAtivo && !wm.getConfigPortalActive()) {
      Serial.println("[portal] tempo esgotado sem configuracao, reiniciando");
      delay(200);
      ESP.restart();
    }
  }

  horaValida = getLocalTime(&tmAgora, 0);   // 0 = nao espera; false ate o NTP chegar
  viraDia();
  expiraManuais(agora);

  static unsigned long tLeitura = 0;
  if ((unsigned long)(agora - tLeitura) >= 2000) {
    tLeitura = agora;
    leSensores(agora);          // unico delay() do loop: 10 x 5 ms na media do ADC
    atualizaCargas(agora);

    char hora[9] = "--:--:--";
    if (horaValida) strftime(hora, sizeof hora, "%H:%M:%S", &tmAgora);
    Serial.printf("%s  umid ", hora);
    if (umidade >= 0) Serial.printf("%d%% (%d)", umidade, umidadeBruto);
    else              Serial.printf("INVALIDA (%d)", umidadeBruto);
    if (tempOk) Serial.printf("  temp %.1fC", tempC);
    else        Serial.print("  temp --");
    /* No REGANDO vai o tempo ligada junto. E com esse numero que se mede o
       enchimento dos canos: olhe em quantos segundos a agua sai na ultima
       saida do cano (README secao 3.1). */
    char est[24];
    if (estado == REGANDO)
      snprintf(est, sizeof est, "REGANDO %lus",
               (unsigned long)((agora - tEstado) / 1000));
    else
      snprintf(est, sizeof est, "%s", NOME_ESTADO[estado]);

    Serial.printf("  %s  B%d N%d L%d V%d  nutri %ds/dia  rssi %d  cfg v%u\n",
                  est, ligado[R_BOMBA], ligado[R_NUTRI],
                  ligado[R_LUZ], ligado[R_VENT], (int)(nutriMsHoje / 1000),
                  WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0, cfg.cfg_versao);
    if (erro.length()) Serial.printf("  ERRO: %s\n", erro.c_str());
  } else {
    atualizaCargas(agora);      // cortes de seguranca rodam em todo loop
  }

  cuidaWifi(agora);
  cicloTelemetria(agora);
}
