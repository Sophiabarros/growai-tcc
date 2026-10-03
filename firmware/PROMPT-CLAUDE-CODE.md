# Tarefa: firmware do GrowAI (ESP32 comum + ESP32-CAM)

Você vai escrever o firmware das duas placas do meu TCC, o **GrowAI**: um sistema semi-hidropônico com IoT e IA para cultivo de plantas medicinais. O repositório é este (`tcc/`), que já contém o site (HTML/CSS/JS na raiz) e o backend (`backend/`, Express + PostgreSQL, publicado na Vercel em `https://growai-backend.vercel.app/api`).

**Escopo:** crie tudo dentro de uma pasta nova `firmware/`. **Não altere nada em `backend/` nem nos arquivos do site.** As rotas de dispositivo do backend (`/api/device/*`) são feitas numa tarefa separada (`backend/PROMPT-CLAUDE-CODE.md`), seguindo o mesmo contrato definido aqui. Se ela já tiver sido feita, confira que o contrato bate com o código do backend. Para testar sem o backend, você vai criar um servidor mock.

Escreva código e comentários em **português**, curtos e diretos. Prefiro código enxuto: nada de classes ou abstrações que não sejam necessárias. Use o firmware atual (no fim deste prompt) como ponto de partida e preserve o estilo e a lógica de segurança dele.

---

## 1. Arquitetura (já decidida, não mude)

- O **backend é o "cérebro"**. As duas placas falam **só com o backend**, por **HTTP(S)**, e **sempre são elas que iniciam a requisição**. O backend roda serverless na Vercel: não há WebSocket, MQTT nem forma de o servidor chamar a placa.
- **As duas placas NÃO se comunicam entre si** (sem UART e sem ESP-NOW). O backend junta a foto com a última leitura da mesma estação.
- **O ESP32 comum** manda a telemetria a cada ~15 s. **A resposta dessa mesma requisição** traz a configuração nova (se mudou) e os comandos manuais pendentes.
- **O ESP32-CAM** tira uma foto a cada 30 min e envia o JPEG. Quem chama a IA é o backend; **a placa nunca fala com a IA e não guarda nenhuma chave de IA**.
- **A segurança é sempre local.** Histerese, tempo máximo de bomba, pausa de absorção e corte por sensor inválido continuam no ESP32 comum e funcionam **mesmo sem Wi-Fi**. O backend só ajusta parâmetros dentro de limites que o próprio firmware valida.

## 2. Estrutura de pastas

```
firmware/
  README.md                 ligação dos fios, como compilar/gravar, calibrar e testar
  PROTOCOLO.md              contrato HTTP completo (para eu implementar no backend depois)
  shared/protocolo.h        constantes comuns às duas placas (intervalo de foto, fuso, versão)
  esp32-main/
    platformio.ini
    src/main.cpp
    include/secrets.example.h
  esp32-cam/
    platformio.ini
    src/main.cpp
    include/secrets.example.h
  tools/
    mock-server.js          servidor de teste em Node puro (sem dependências)
```

- Use **PlatformIO** (framework arduino). Se o `pio` não estiver instalado, instale com `pip install platformio`. Envs: `esp32dev` para a placa principal e `esp32cam` (AI-Thinker, com `-DBOARD_HAS_PSRAM`) para a câmera.
- Inclua `shared/` nos dois projetos via `build_flags = -I ../shared`.
- `include/secrets.h` (copiado do `.example`) guarda `WIFI_SSID`, `WIFI_PASS`, `API_BASE` e `DEVICE_KEY`. **Adicione `firmware/**/secrets.h` e `firmware/**/.pio/` ao `.gitignore` da raiz.**
- `API_BASE` pode ser `https://...` (Vercel) ou `http://192.168.x.x:3001/api` (mock na rede local). O código escolhe `WiFiClientSecure` ou `WiFiClient` pelo prefixo. Para HTTPS, use o bundle de certificados do core ESP32, se for viável na versão do core usada. Se não for, use `setInsecure()` com um comentário explicando a limitação.
- Bibliotecas (via `lib_deps`): `bblanchon/ArduinoJson@^7`, `paulstoffregen/OneWire` e `milesburton/DallasTemperature`. `esp_camera`, `Preferences`, `HTTPClient` e `WiFi` já vêm no core.

## 3. Hardware

### ESP32 comum (DevKit 30 pinos)

| Função | GPIO | Observação |
|---|---|---|
| Sensor capacitivo de umidade | 34 | ADC1 (funciona com Wi-Fi ligado). Mantenha a calibração `AR=3200`, `AGUA=1350` |
| DS18B20 (temperatura) | 25 | OneWire, pull-up de 4,7 kΩ |
| Relé – bomba d'água | 26 | |
| Relé – LED Grow (UV) | 27 | |
| Relé – 2 microventiladores 12 V | 14 | |
| Relé – minibomba de nutrientes | 32 | |

- Declare todos os pinos como constantes no topo do `main.cpp`, para eu poder trocar fácil.
- **Não use** os GPIO 34–39 para o DS18B20 (são só entrada, e o OneWire precisa escrever no pino) nem o GPIO 12 (pino de boot). Se eu pedir esses pinos, me avise.
- O GPIO 14 solta um sinal PWM rápido durante o boot, antes do `setup()`, então os ventiladores podem dar um "pulso" ao ligar a placa. É aceitável para ventiladores; só documente isso no README.
- O módulo relé **aciona em nível ALTO**: mantenha `RELE_ATIVO_BAIXO = false` e a função `rele()`.
- No `setup()`, chame `pinMode` e deixe **todas as cargas desligadas** antes de qualquer outra coisa. Isso evita o "tec" no boot. A luz liga depois, conforme o fotoperíodo.
- DS18B20: use a leitura **não bloqueante** (`setWaitForConversion(false)`, pedir e ler no ciclo seguinte). `-127` ou `85` na primeira leitura = inválido → envie `null`.

### ESP32-CAM (AI-Thinker + placa MB)

- Pinagem padrão da câmera AI-Thinker.
- O **LED de flash** fica no **GPIO 4**.
- Não use cartão SD.

## 4. ESP32 comum: comportamento

### 4.1 Controle local (vale sempre, com ou sem internet)

- **Irrigação:** mantenha a máquina de estados atual (`MONITORANDO → REGANDO → ABSORVENDO`), com histerese `umid_liga`/`umid_desliga`, **`MAX_BOMBA` 20 s por ciclo** e **`ABSORCAO` 5 min**. Com sensor inválido, a bomba desliga na hora e o erro vai na telemetria.
- **Luz (fotoperíodo):** liga entre `luz_on` e `luz_off` (horário local). **Enquanto a hora ainda não foi obtida via NTP, a luz fica LIGADA** (fallback seguro).
- **Janela de foto:** a luz roxa do LED Grow distorce as cores da foto e atrapalharia a análise de amarelamento pela IA. Por isso, com a hora válida, **desligue a luz por `FOTO_JANELA_S` segundos (padrão 40) a cada `FOTO_INTERVALO_MIN` minutos (padrão 30)**, começando no minuto múltiplo exato (ex.: 12:00:00–12:00:40 e 12:30:00–12:30:40). As constantes ficam em `shared/protocolo.h`. A câmera fotografa dentro dessa janela usando o próprio flash.
- **Ventiladores:** ligam `vent_min_por_hora` minutos no início de cada hora (estresse mecânico leve) **ou** sempre que `temp_c > temp_max`. Desligam quando nenhuma das duas condições vale (com 1 °C de histerese na temperatura).
- **Nutrientes:** uma dose por dia, no horário `nutri_hora`, ligando a minibomba por `nutri_s` segundos. Limite duro: **máximo de 30 s por dia**, com o contador zerando à meia-noite. Precisa de hora válida; sem hora, não dosa. Não dosa enquanto a bomba d'água estiver ligada.
- **Nunca use `delay()` longo no `loop()`.** Tudo é baseado em `millis()`, como no código atual. O `delay(5)` da média do ADC pode ficar.
- Ative o **watchdog** (`esp_task_wdt`, ~30 s).

### 4.2 Configuração

- Estrutura `Config` com: `umid_liga`, `umid_desliga`, `luz_on`, `luz_off` (minutos desde meia-noite; no JSON, string `"HH:MM"`), `vent_min_por_hora`, `temp_max`, `nutri_hora`, `nutri_s` e `cfg_versao`.
- Padrões de fábrica: 40 / 60 / 06:00 / 18:00 / 10 / 30.0 / 08:00 / 8 / versão 0.
- **Salve em NVS (`Preferences`)** a cada config nova aceita e carregue no boot. Depois de reiniciar, a placa segue a última config mesmo sem Wi-Fi.
- **Valide antes de aceitar** e rejeite a config inteira se algo falhar (mantenha a anterior):
  - `umid_liga` entre 15 e 80;
  - `umid_desliga` ≥ `umid_liga + 5` e ≤ 95;
  - horários válidos;
  - `vent_min_por_hora` entre 0 e 60;
  - `temp_max` entre 15 e 45;
  - `nutri_s` entre 0 e 30.
  
  Informe o erro no campo `erro_cfg` da próxima telemetria.

### 4.3 Comandos manuais

- Formato: `{"id":126,"rele":"bomba|nutri|luz|vent","acao":"ligar|desligar","dur_s":600}`.
- `ligar` sobrepõe o automático daquele relé por `dur_s` segundos (máx. 3600). `desligar` encerra a sobreposição e **devolve o relé ao automático**.
- **Limites que nenhum comando fura:**
  - `bomba`: no máximo `MAX_BOMBA`, e nunca com o sensor inválido;
  - `nutri`: conta no limite diário de 30 s.
- Guarde os `id`s executados e mande em `acks` na próxima telemetria. Ignore `id` repetido.

### 4.4 Rede

- Wi-Fi com reconexão automática **sem bloquear o controle local** (sem `while (WiFi.status() != ...)` travando o `loop`).
- NTP com fuso de São Paulo, sem horário de verão: `configTzTime("<-03>3", "pool.ntp.org", "a.st1.ntp.br")`.
- A telemetria sai a cada `proxima_em_s` (padrão 15 s; aceite de 5 a 300). Timeout HTTP de 10 s. Se falhar, tente de novo com backoff (15 → 30 → 60 s, no máximo) e continue controlando localmente.
- Imprima no Serial (115200) um resumo de cada ciclo, no mesmo estilo do código atual.

## 5. ESP32-CAM: comportamento

- Ciclo com **deep sleep**: acorda → conecta no Wi-Fi → sincroniza o NTP → espera o instante `janela + FOTO_OFFSET_S` (padrão 15 s depois do início da janela, quando a luz roxa já apagou) → liga o flash (GPIO 4) → **descarta 2 frames** para o balanço de branco estabilizar → captura → desliga o flash → envia → dorme até ~60 s antes da próxima janela.
- O flash fica ligado **só durante a captura**, nunca mais que ~2 s.
- Se o NTP falhar, tira a foto mesmo assim, envia com `X-Captured-At: 0` e dorme `FOTO_INTERVALO_MIN`.
- Câmera: `FRAMESIZE_SVGA` (800×600), `jpeg_quality` 12, `fb_count` 2 com PSRAM, AWB e AEC automáticos. Se `esp_camera_init` falhar, espere 5 s e reinicie; depois de 3 falhas seguidas, dorme e tenta na próxima janela.
- **Não desative o detector de brownout.** Se ocorrer brownout, é problema de alimentação, a ser corrigido no hardware (documente isso no README).
- Tempo máximo acordada: 60 s. Depois disso, dorme de qualquer jeito.

## 6. Contrato HTTP

Documente tudo em `PROTOCOLO.md`, com exemplos. As duas rotas usam o header `X-Device-Key: <DEVICE_KEY>` e **não** usam o JWT do usuário.

### `POST {API_BASE}/device/telemetria` (ESP32 comum, JSON)

```json
{
  "fw": "main-1.0.0",
  "cfg_versao": 3,
  "umidade": 52,
  "umidade_bruto": 2410,
  "temp_c": 24.8,
  "estado": "MONITORANDO",
  "reles": {"bomba": 0, "nutri": 0, "luz": 1, "vent": 0},
  "manual": {"vent": 540},
  "nutri_s_hoje": 8,
  "hora_valida": true,
  "rssi": -61,
  "uptime_s": 12345,
  "acks": [125],
  "erro": null,
  "erro_cfg": null
}
```

- `umidade` e `temp_c` podem ser `null` quando o sensor for inválido.
- `manual` lista os segundos restantes de cada sobreposição manual.

Resposta `200`:

```json
{
  "cfg_versao": 4,
  "config": {"umid_liga": 60, "umid_desliga": 75, "luz_on": "06:00", "luz_off": "18:00",
             "vent_min_por_hora": 10, "temp_max": 30, "nutri_hora": "08:00", "nutri_s": 8},
  "comandos": [{"id": 126, "rele": "vent", "acao": "ligar", "dur_s": 600}],
  "proxima_em_s": 15
}
```

- `config` só vem quando `cfg_versao` do servidor ≠ a da placa.
- `comandos` pode vir vazio ou ausente.
- `401` = chave inválida: loga e tenta de novo em 60 s.

### `POST {API_BASE}/device/foto` (ESP32-CAM)

- Corpo: **JPEG puro**, com `Content-Type: image/jpeg` (não use multipart).
- Headers extras: `X-Device-Key`, `X-Captured-At: <epoch UTC>` e `X-Fw: cam-1.0.0`.
- Resposta `200`: `{"ok": true}`. Qualquer outra resposta: loga e segue o ciclo normalmente, sem tentar reenviar.

## 7. Servidor mock (`tools/mock-server.js`)

- Node puro (`http`, `fs`), sem `npm install`, rodando na porta 3001 e ouvindo em `0.0.0.0`. Imprima na inicialização os IPs locais da máquina.
- Implemente as duas rotas do contrato, validando `X-Device-Key` contra a env `DEVICE_KEY` (padrão `teste123`).
- `/device/telemetria`: loga cada telemetria de forma legível e responde com a config atual e os comandos pendentes. Os comandos passam a "confirmados" quando o `id` volta em `acks`.
- `/device/foto`: salva as fotos em `tools/fotos/<timestamp>.jpg` (e coloque essa pasta no `.gitignore`).
- Rotas de controle para eu testar pelo navegador:
  - `GET /mock/cmd?rele=vent&acao=ligar&dur_s=60` enfileira um comando;
  - `GET /mock/config?umid_liga=50&umid_desliga=70` altera a config e incrementa `cfg_versao`;
  - `GET /mock/estado` mostra a última telemetria, a config e a fila.

## 8. README.md

Precisa ter:

1. Tabela de ligação dos fios das duas placas, incluindo a alimentação (com os pinos da seção 3).
2. Como gravar: o ESP32 comum pela USB; o ESP32-CAM pela placa MB (botão IO0/BOOT se precisar).
3. Como calibrar o sensor de umidade usando `umidade_bruto`.
4. Como medir a vazão da minibomba (mL em 10 s) para escolher `nutri_s`.
5. Como testar com o mock na rede local.
6. Problemas comuns:
   - brownout na CAM;
   - rede 5 GHz (o ESP32 só conecta em 2,4 GHz);
   - rede com portal de login (não funciona; use o roteador do celular);
   - DS18B20 lendo -127.

## 9. Critérios de pronto

- `pio run` compila **os dois projetos sem erros** (rode `pio run -d firmware/esp32-main` e `pio run -d firmware/esp32-cam`). Mostre o uso de flash e RAM de cada um.
- `node firmware/tools/mock-server.js` sobe sem erros. Teste as rotas com `curl`, simulando uma telemetria e o envio de uma foto (qualquer JPEG pequeno).
- Revise o código procurando: `delay()` longo no `loop` do main, carga que possa ficar ligada sem limite de tempo, e config inválida que passe pela validação.
- No fim, me dê um resumo curto: arquivos criados, o que falta eu testar no hardware e qualquer decisão que você tomou que não estava neste prompt.

## 10. Configuração final e gravação nas placas

O hardware já está montado e o backend já tem as rotas `/api/device/*` publicadas (feito pelo `backend/PROMPT-CLAUDE-CODE.md`). Depois dos critérios de pronto:

1. **Me pergunte** o nome e a senha do Wi-Fi (2,4 GHz) e as duas chaves de dispositivo (`main` e `cam`) geradas pelo `backend/scripts/criar-dispositivo.js`. Se eu ainda não tiver as chaves, rode o script por mim, depois de me pedir confirmação.
2. Crie os dois `include/secrets.h` com esses valores e `API_BASE = "https://growai-backend.vercel.app/api"`. Confirme que esses arquivos estão **ignorados pelo git** (`git check-ignore`).
3. Grave **uma placa por vez**. Me peça para conectar o ESP32 comum na USB, rode `pio run -d firmware/esp32-main -t upload` e depois `pio device monitor -b 115200` por ~1 min. Confira no Serial:
   - Wi-Fi conectado;
   - hora NTP válida;
   - telemetria com resposta `200`;
   - leituras de umidade e temperatura coerentes.
4. Faça o mesmo com o ESP32-CAM pela placa MB. Se o upload falhar, me explique como segurar o botão IO0/BOOT. Confira:
   - câmera iniciada;
   - foto enviada com `200`;
   - a placa entrou em deep sleep.
5. **Teste de ponta a ponta:** confirme pelo backend de produção (ou me peça para abrir o app) que a leitura e a foto analisada apareceram. Crie um comando manual de teste para os ventiladores por 30 s e veja o relé acionar e o `ack` voltar.
6. Me entregue um resumo com o que funcionou, o que falhou e o que devo conferir quando as plantas estiverem no lugar (calibração no substrato real, vazão da minibomba e enquadramento da câmera).

Se alguma coisa aqui for tecnicamente impossível ou arriscada, **me pergunte antes** de mudar a arquitetura.

---

## Firmware atual (ESP32 comum): ponto de partida

```cpp
/* Horta Automatizada - ESP32
   Sensor capacitivo -> GPIO 34 | Bomba -> IN1 | Fita LED -> IN2
   Bomba e fita ligadas no contato NO (normalmente aberto) do relé.
   Calibre AR e AGUA com o valor bruto impresso no Serial (115200). */

const uint8_t SENSOR = 34, BOMBA = 26, LUZ = 27;  // confira os pinos do relé
const bool RELE_ATIVO_BAIXO = false;              // este módulo aciona em HIGH

const int AR = 3200, AGUA = 1350;                 // seco no ar / dentro d'água
const int LIGA = 40, DESLIGA = 60;                // histerese (%)
const unsigned long MAX_BOMBA = 20000;            // 20 s por ciclo
const unsigned long ABSORCAO  = 300000;           // 5 min de pausa

enum { MONITORANDO, REGANDO, ABSORVENDO };
uint8_t estado = MONITORANDO;
unsigned long t0 = 0, tLeitura = 0;

void rele(uint8_t p, bool on) {
  digitalWrite(p, (RELE_ATIVO_BAIXO ? !on : on) ? HIGH : LOW);
}

int lerUmidade() {                     // -1 = leitura inválida
  long soma = 0;
  for (int i = 0; i < 10; i++) { soma += analogRead(SENSOR); delay(5); }
  int bruto = soma / 10;
  Serial.printf("bruto: %d  ", bruto);
  if (bruto < 500 || bruto > 4000) return -1;
  return constrain(map(bruto, AR, AGUA, 0, 100), 0, 100);
}

void setup() {
  Serial.begin(115200);
  pinMode(BOMBA, OUTPUT);              // pinMode antes de escrever: evita o "tec" no boot
  pinMode(LUZ, OUTPUT);
  rele(BOMBA, false);                  // bomba parada ao ligar
  rele(LUZ, true);                     // luz sempre ligada
  analogReadResolution(12);
  analogSetPinAttenuation(SENSOR, ADC_11db);
}

void loop() {
  unsigned long agora = millis();

  // corta a bomba no tempo máximo, aconteça o que acontecer
  if (estado == REGANDO && agora - t0 >= MAX_BOMBA) {
    rele(BOMBA, false);
    estado = ABSORVENDO;
    t0 = agora;
  }

  if (agora - tLeitura >= 2000) {
    tLeitura = agora;
    int umidade = lerUmidade();

    if (umidade < 0) {                          // sensor solto ou em curto
      rele(BOMBA, false);
      estado = MONITORANDO;
      Serial.println("ERRO: sensor invalido, verifique o GPIO 34");
    } else {
      Serial.printf("umidade: %d%%  estado: %d\n", umidade, estado);
      if (estado == MONITORANDO && umidade < LIGA) {
        rele(BOMBA, true);
        estado = REGANDO;
        t0 = agora;
      } else if (estado == REGANDO && umidade >= DESLIGA) {
        rele(BOMBA, false);
        estado = ABSORVENDO;
        t0 = agora;
      }
    }
  }

  if (estado == ABSORVENDO && agora - t0 >= ABSORCAO) estado = MONITORANDO;
}
```
