#pragma once
/* Placa: ESP32 cam
 *
 * VOCE PROVAVELMENTE NAO PRECISA MEXER AQUI.
 *
 * Wi-Fi, endereco da API e chave da placa sao configurados pelo PORTAL, no
 * celular, e ficam guardados na memoria da placa (NVS). Nao e preciso
 * recompilar nem ligar o cabo para trocar de rede.
 *
 * Como usar o portal:
 *   1. a placa cria a rede Wi-Fi "GrowAI-setup" (senha growai123);
 *   2. conecte o celular nela e a pagina abre sozinha;
 *   3. escolha a rede, digite a senha e cole a chave da placa;
 *   4. ela salva e reinicia conectada.
 *
 * O portal abre quando:
 *   - a placa nunca foi configurada;
  *   - ela falha 3 ciclos seguidos ao conectar (a rede mudou).
 *
 * Os valores abaixo sao apenas o PADRAO DE FABRICA: valem enquanto a NVS
 * estiver vazia, e o que for configurado pelo portal sempre vence. Deixe-os
 * em branco, a nao ser que voce queira gravar uma placa ja configurada (util
 * para montar varias iguais de uma vez).
 *
 * Copie este arquivo para secrets.h. Ele esta no .gitignore da raiz.
 */

#define WIFI_SSID  ""
#define WIFI_PASS  ""

/* Sem barra no fim. Ex.: "https://growai-backend.vercel.app/api" */
#define API_BASE   ""

/* A chave DESTA placa. Cada uma tem a sua: a rota POST /api/device/foto
   aceita somente a chave do tipo 'cam'. Gere com:
     npm run criar-dispositivo -- <station_id> cam */
#define DEVICE_KEY ""
