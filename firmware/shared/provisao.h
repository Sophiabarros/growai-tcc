#pragma once
/* Credenciais gravadas na placa, configuradas pelo portal — nao pelo codigo.
 *
 * Antes, Wi-Fi, API_BASE e DEVICE_KEY eram #define no secrets.h: trocar de
 * rede exigia recompilar e regravar a placa com o cabo. Agora os quatro valores
 * vivem na NVS (a mesma memoria que ja guarda a config de cultivo) e sao
 * preenchidos pelo portal de configuracao:
 *
 *   1. a placa nao consegue conectar;
 *   2. ela cria a propria rede Wi-Fi (PORTAL_SSID);
 *   3. voce conecta o celular nela e abre a pagina que aparece sozinha;
 *   4. escolhe a rede, digita a senha, cola a chave da placa;
 *   5. ela salva e reinicia conectada.
 *
 * O secrets.h continua existindo, mas so como VALOR PADRAO de fabrica: o que
 * esta na NVS sempre vence. Deixar o secrets.h com strings vazias e o normal.
 *
 * Header-only (funcoes `inline`) porque o PlatformIO so adiciona `shared/` ao
 * include path (-I ../shared); um .cpp aqui nao seria compilado.
 */

#include <Arduino.h>
#include <Preferences.h>
#include <WiFi.h>

/* Nome da rede que a placa cria quando precisa ser configurada. Some assim que
   ela conecta. A senha existe para o vizinho nao entrar e reconfigurar a sua
   horta; 8 caracteres e o minimo que o ESP32 aceita para WPA2. */
#define PORTAL_SSID  "GrowAI-setup"
#define PORTAL_SENHA "growai123"

// Minutos que o portal fica no ar antes de a placa desistir e reiniciar.
static const int PORTAL_TIMEOUT_S = 180;

struct Credenciais {
  String ssid;
  String senha;
  String apiBase;    // sem barra no fim, ex.: https://growai-backend-ssca.onrender.com/api
  String deviceKey;  // a chave DESTA placa (main e cam tem chaves diferentes)
};

/* Tira a barra do fim e espacos das pontas. Colar a URL do navegador costuma
   trazer a barra junto, e "https://.../api/" + "/device/foto" viraria
   ".../api//device/foto", que o Express nao casa com a rota. */
inline String provisaoNormalizaUrl(String u) {
  u.trim();
  while (u.endsWith("/")) u.remove(u.length() - 1);
  return u;
}

inline bool provisaoCompleta(const Credenciais &c) {
  return c.ssid.length() > 0 && c.apiBase.length() > 0 && c.deviceKey.length() > 0;
}

/* Endereco atual do backend e os que ja deixaram de ser usados.
   O que o portal grava na NVS vence o secrets.h, entao uma placa configurada
   com o endereco antigo continuaria nele para sempre mesmo regravada. Ao
   carregar, um endereco desta lista e trocado pelo atual e salvo de volta:
   recompilar e gravar basta, sem abrir o portal. */
static const char *API_ATUAL = "https://growai-backend-ssca.onrender.com/api";
static const char *API_ANTIGAS[] = {
  "https://growai-backend.vercel.app/api",   // Vercel, ate 2026-10
};

/* Carrega da NVS. O que estiver vazio la cai para o padrao do secrets.h, o que
   permite gravar uma placa ja configurada se voce quiser. */
inline void provisaoCarregar(Credenciais &c,
                             const char *padraoSsid, const char *padraoSenha,
                             const char *padraoApi, const char *padraoKey) {
  Preferences nvs;
  nvs.begin("growai-net", true);
  c.ssid      = nvs.getString("ssid", padraoSsid);
  c.senha     = nvs.getString("pass", padraoSenha);
  c.apiBase   = nvs.getString("api", padraoApi);
  c.deviceKey = nvs.getString("key", padraoKey);
  nvs.end();

  c.apiBase = provisaoNormalizaUrl(c.apiBase);
  c.ssid.trim();
  c.deviceKey.trim();

  for (const char *antiga : API_ANTIGAS) {
    if (c.apiBase.equalsIgnoreCase(antiga)) {
      Serial.printf("[cred] api antiga (%s) trocada por %s\n", antiga, API_ATUAL);
      c.apiBase = API_ATUAL;
      nvs.begin("growai-net", false);
      nvs.putString("api", c.apiBase);
      nvs.end();
      break;
    }
  }
}

inline void provisaoSalvar(const Credenciais &c) {
  Preferences nvs;
  nvs.begin("growai-net", false);
  nvs.putString("ssid", c.ssid);
  nvs.putString("pass", c.senha);
  nvs.putString("api", provisaoNormalizaUrl(c.apiBase));
  nvs.putString("key", c.deviceKey);
  nvs.end();
}

/* "Trocar a rede Wi-Fi" pelo app: esquece SO a rede e a senha. O endereco da
   API e a chave continuam gravados, entao no portal basta escolher a rede
   nova. Rede vazia = provisaoCompleta() falso: se o portal fechar sem
   ninguem configurar, a placa reinicia e abre o portal de novo, em vez de
   voltar para a rede antiga. */
inline void provisaoEsquecerRede(Credenciais &c) {
  c.ssid = "";
  c.senha = "";
  provisaoSalvar(c);
}

/* Rede gravada pelo cabo (wifi_forcar.h). Procura as redes por perto para
   acertar maiusculas/minusculas do nome ("IPhone de X" acha "iPhone de X"),
   grava na NVS e mantem a API e a chave. So roda quando o arquivo existe. */
inline void provisaoForcarRede(Credenciais &c, const char *ssid, const char *senha) {
  String alvo = ssid;
  WiFi.mode(WIFI_STA);
  int n = WiFi.scanNetworks();
  bool achou = false;
  Serial.printf("[cred] redes 2,4 GHz que a placa enxerga (%d):\n", n);
  for (int i = 0; i < n; i++) {
    Serial.printf("[cred]   \"%s\"  sinal %d dBm\n", WiFi.SSID(i).c_str(), WiFi.RSSI(i));
    if (!achou && WiFi.SSID(i).equalsIgnoreCase(alvo)) { alvo = WiFi.SSID(i); achou = true; }
  }
  WiFi.scanDelete();
  Serial.printf("[cred] rede forcada pelo cabo: %s (%s)\n", alvo.c_str(),
                achou ? "ENCONTRADA" : "NAO aparece na busca");
  if (c.ssid != alvo || c.senha != senha) {
    c.ssid = alvo;
    c.senha = senha;
    provisaoSalvar(c);
    Serial.println("[cred] rede nova salva na NVS");
  }
}

// Apaga tudo: a proxima inicializacao cai direto no portal.
inline void provisaoLimpar() {
  Preferences nvs;
  nvs.begin("growai-net", false);
  nvs.clear();
  nvs.end();
}

// Log sem vazar a senha nem a chave inteira no Serial.
inline void provisaoMostrar(const Credenciais &c) {
  Serial.printf("[cred] rede: %s\n", c.ssid.length() ? c.ssid.c_str() : "(nao configurada)");
  Serial.printf("[cred] api : %s\n", c.apiBase.length() ? c.apiBase.c_str() : "(nao configurada)");
  if (c.deviceKey.length() >= 6) {
    Serial.printf("[cred] chave: ...%s (%d caracteres)\n",
                  c.deviceKey.substring(c.deviceKey.length() - 6).c_str(), c.deviceKey.length());
  } else {
    Serial.println("[cred] chave: (nao configurada)");
  }
}
