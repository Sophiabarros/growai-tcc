#pragma once
/* GrowAI - constantes comuns as DUAS placas.
   Mudou algo aqui? Regrave o ESP32 principal E o ESP32-CAM, senao a janela
   de foto das duas deixa de coincidir e a foto sai com a luz roxa acesa. */

#define PROTOCOLO_VERSAO 1

/* --- Janela de foto ---------------------------------------------------
   A cada FOTO_INTERVALO_MIN minutos (a partir do minuto multiplo exato:
   :00 e :30) o ESP32 principal apaga o LED Grow por FOTO_JANELA_S segundos.
   A CAM captura FOTO_OFFSET_S depois do inicio da janela, quando a luz roxa
   ja apagou e o balanco de branco da camera estabilizou.

   Regra: FOTO_OFFSET_S < FOTO_JANELA_S < 60.
   O limite de 60 vem da conta `minuto % INTERVALO == 0 && segundo < JANELA`,
   que so funciona se a janela nao atravessar a virada do minuto. */
static const int FOTO_INTERVALO_MIN = 30;
static const int FOTO_JANELA_S      = 40;
static const int FOTO_OFFSET_S      = 15;

/* --- Ritmo da CAM ----------------------------------------------------
   CAM_PRE_S: quantos segundos antes do inicio da janela a CAM acorda.
   Tem que caber: conectar no Wi-Fi (~10 s) + NTP (~3 s) + folga.

   CAM_MAX_ACORDADA_S: trava de seguranca. Passou disso, a CAM dorme de
   qualquer jeito, mesmo sem ter tirado ou enviado a foto. Precisa ser
   maior que CAM_PRE_S + FOTO_OFFSET_S (= 60 s) + o tempo de envio. */
static const int CAM_PRE_S           = 45;
static const int CAM_MAX_ACORDADA_S  = 90;

/* --- Hora ------------------------------------------------------------
   Fuso de Sao Paulo em formato POSIX TZ, sem horario de verao (extinto em
   2019). O sinal e invertido de proposito: "<-03>3" quer dizer UTC-3. */
#define TZ_SP  "<-03>3"
#define NTP1   "pool.ntp.org"
#define NTP2   "a.st1.ntp.br"

/* --- Rede ------------------------------------------------------------ */
static const int HTTP_TIMEOUT_MS = 10000;

/* Segundos desde o inicio do ciclo de foto atual.
   Ex.: 12:31:05 com intervalo 30 -> 65. */
static inline int segNoCicloFoto(int minuto, int segundo) {
  return (minuto % FOTO_INTERVALO_MIN) * 60 + segundo;
}

/* A luz tem que estar apagada agora? */
static inline bool naJanelaFoto(int minuto, int segundo) {
  return segNoCicloFoto(minuto, segundo) < FOTO_JANELA_S;
}

/* Invariantes conferidos pelo compilador: se alguem mexer nas constantes de
   cima e quebrar uma destas regras, o build FALHA em vez de gerar um firmware
   que tira foto com a luz roxa acesa. */
static_assert(FOTO_OFFSET_S < FOTO_JANELA_S,
              "a CAM capturaria depois da luz voltar");
static_assert(FOTO_JANELA_S < 60,
              "a janela nao pode atravessar a virada do minuto: naJanelaFoto() para de funcionar");
static_assert(FOTO_INTERVALO_MIN > 0 && 60 % FOTO_INTERVALO_MIN == 0,
              "o intervalo precisa dividir 60, senao as janelas nao caem sempre no mesmo minuto");
static_assert(CAM_PRE_S + FOTO_OFFSET_S < CAM_MAX_ACORDADA_S,
              "a trava de tempo acordada dispararia antes da captura");
static_assert(CAM_PRE_S + 10 < FOTO_INTERVALO_MIN * 60,
              "a CAM acordaria antes de ter dormido");
