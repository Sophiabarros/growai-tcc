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
  String apiBase;    // sem barra no fim, ex.: https://growai-backend.vercel.app/api
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
