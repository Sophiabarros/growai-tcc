#pragma once
/* Gravar uma rede Wi-Fi pelo cabo, sem abrir o portal.
 *
 * Copie para firmware/esp32-main/include/wifi_forcar.h (ou esp32-cam/include/),
 * preencha, grave a placa e confira a conexao no monitor serial. Depois APAGUE
 * o wifi_forcar.h e grave de novo: a rede ja fica na NVS, e sem o arquivo a
 * placa volta a aceitar trocar de rede pelo portal/app.
 *
 * O arquivo real e ignorado pelo Git (.gitignore): a senha nunca vai pro repo.
 * O nome da rede e comparado sem diferenciar maiusculas ("IPhone" acha "iPhone"). */
#define WIFI_FORCAR_SSID  "nome da rede"
#define WIFI_FORCAR_SENHA "senha da rede"
