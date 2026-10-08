# Contrato HTTP das rotas de dispositivo

Este é o contrato que o firmware já fala. Serve para implementar as rotas no
`backend/` depois, sem ter que reabrir o código das placas.

## Visão geral

```
ESP32 principal  --POST /api/device/telemetria-->  backend  (a cada ~15 s)
                 <--config + comandos-------------
ESP32-CAM        --POST /api/device/foto-------->  backend  (a cada 30 min)
                 <--{"ok":true}------------------
```

Regras que valem para as duas rotas:

- **A placa sempre inicia a requisição.** O backend roda serverless na Vercel:
  não há WebSocket nem jeito de o servidor chamar a placa. Tudo que o backend
  quer mandar viaja na *resposta* de uma requisição que a placa fez.
- **As duas placas não se falam.** Quem junta a foto com a leitura da mesma
  estação é o backend.
- Autenticação por header `X-Device-Key`. **Não usa o JWT do usuário** — as
  placas não têm login.
- **Uma chave por placa**, não uma compartilhada. O backend guarda só o sha256 e
  usa a chave para descobrir de qual estação a placa é. `/device/telemetria`
  aceita só a placa `tipo='main'`; `/device/foto` só a `tipo='cam'`. Chave da
  placa errada na rota errada → `401`.
- Chave errada, ausente, ou do tipo errado → `401`.
- As chaves saem de `backend/scripts/criar-dispositivo.js <station_id> <main|cam>`,
  que imprime cada uma **uma única vez**.

### Onde montar no Express

As rotas atuais ficam em `backend/server.js` sob `/api/*`, e `stations`,
`reports`, `suggestions` e `settings` passam por `requireAuth`. As rotas de
dispositivo **não** podem passar por ele. Monte antes:

```js
const deviceRoutes = require("./routes/device");
app.use("/api/device", deviceRoutes);          // valida X-Device-Key por dentro
app.use("/api/stations", requireAuth, stationsRoutes);
```

A rota da foto recebe binário, então precisa de um parser próprio antes do
`express.json()` global, ou um `express.raw()` só nela:

```js
router.post("/foto", express.raw({ type: "image/jpeg", limit: "2mb" }), handler);
```

---

## `POST /api/device/telemetria`

**Quem chama:** ESP32 principal, a cada `proxima_em_s` segundos (padrão 15).

**Headers**

| Header | Valor |
|---|---|
| `Content-Type` | `application/json` |
| `X-Device-Key` | a `DEVICE_KEY` compartilhada |

**Corpo**

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

| Campo | Tipo | Significado |
|---|---|---|
| `fw` | string | versão do firmware da placa |
| `cfg_versao` | int | versão da config que a placa está usando agora |
| `umidade` | int 0–100 **ou `null`** | `null` = sensor solto ou em curto |
| `umidade_bruto` | int | valor cru do ADC (0–4095). **Use este para calibrar** |
| `temp_c` | float **ou `null`** | `null` = DS18B20 sem leitura |
| `estado` | string | `MONITORANDO`, `REGANDO` ou `ABSORVENDO` |
| `reles` | objeto | estado real de cada relé, `0`/`1` |
| `manual` | objeto | segundos que **restam** de cada sobreposição manual; só aparecem os relés com sobreposição ativa. `{}` = tudo no automático |
| `nutri_s_hoje` | int | segundos de nutriente já dosados hoje (zera à meia-noite local) |
| `hora_valida` | bool | `false` = NTP ainda não chegou. Com `false`, a luz fica acesa e não há dose de nutriente |
| `rssi` | int | dBm do Wi-Fi |
| `uptime_s` | int | segundos desde o boot |
| `acks` | array de int | ids de comandos que a placa já executou |
| `erro` | string ou `null` | falha de sensor |
| `erro_cfg` | string ou `null` | motivo da última config recusada |

**Resposta `200`**

```json
{
  "cfg_versao": 4,
  "config": {
    "umid_liga": 60, "umid_desliga": 75,
    "luz_on": "06:00", "luz_off": "18:00",
    "vent_min_por_hora": 10, "temp_max": 30,
    "nutri_hora": "08:00", "nutri_s": 8
  },
  "comandos": [{"id": 126, "rele": "vent", "acao": "ligar", "dur_s": 600}],
  "proxima_em_s": 15
}
```

| Campo | Obrigatório | Regra |
|---|---|---|
| `cfg_versao` | sim | versão que o servidor considera atual |
| `config` | **só quando** `cfg_versao` do servidor ≠ o que a placa mandou | objeto inteiro; ver limites abaixo |
| `comandos` | não | pode vir vazio ou ausente |
| `proxima_em_s` | não | a placa aceita 5–300 e corta fora disso; ausente = 15 |

**Outros códigos**

| Código | O que a placa faz |
|---|---|
| `401` | loga e tenta de novo em 60 s |
| qualquer outro, ou timeout | backoff 15 → 30 → 60 s, **e segue controlando localmente** |

---

## Versionamento da config (`cfg_versao`)

1. A placa manda a versão que está usando.
2. Se for diferente da do servidor, o servidor responde com `config` **inteira**.
3. A placa valida. **Aceita:** grava na NVS, passa a usar `cfg_versao` da
   resposta, e `erro_cfg` volta a `null`.
4. **Recusa:** mantém a config *e a versão antigas*, e manda o motivo em
   `erro_cfg` na telemetria seguinte. Como a versão não mudou, o servidor vai
   reenviar — corrija o valor e ele passa.

Ou seja: `erro_cfg` preenchido + `cfg_versao` que não avança = a config que
você mandou está sendo rejeitada. O motivo vem escrito.

### Limites que o firmware exige

Mandar fora disso faz a placa **recusar a config inteira**, não só o campo.

| Campo | Tipo no JSON | Limite |
|---|---|---|
| `umid_liga` | int | 15 a 80 |
| `umid_desliga` | int | ≥ `umid_liga + 5` **e** ≤ 95 |
| `luz_on` | string `"HH:MM"` | 00:00–23:59 |
| `luz_off` | string `"HH:MM"` | 00:00–23:59 |
| `vent_min_por_hora` | int | 0 a 60 |
| `temp_max` | número | 15 a 45 |
| `nutri_hora` | string `"HH:MM"` | 00:00–23:59 |
| `nutri_s` | int | 0 a 30 |

Detalhes que economizam dor de cabeça:

- As horas são **string `"HH:MM"`** no JSON. Mandar número quebra a config toda.
- `luz_on == luz_off` significa **24 h aceso**. `luz_on > luz_off` atravessa a
  meia-noite (ex.: `"20:00"` a `"04:00"`).
- ⚠️ **A hora precisa vir já reduzida a 00:00–23:59.** O backend calcula
  `luz_off = luz_inicio + light_hours`, e isso estoura 24 h fácil: 18:00 + 10 h
  dá "28:00", que o firmware **recusa** (hora inválida) e derruba a config
  inteira. Aplique o módulo antes de serializar:

  ```js
  const fmt = (min) => {
    const m = ((min % 1440) + 1440) % 1440;        // resolve >24h e negativo
    return String(Math.floor(m / 60)).padStart(2, "0") + ":" +
           String(m % 60).padStart(2, "0");
  };
  luz_off: fmt(luz_inicio_min + light_hours * 60)  // 18:00 + 10h -> "04:00"
  ```

  O firmware entende `"04:00"` como fotoperíodo que atravessa a meia-noite, que
  é exatamente o que se quer.
- Campo ausente = a placa mantém o valor atual dele. Mas prefira mandar o
  objeto completo: é mais fácil de conferir depois.

---

## Comandos manuais

```json
{"id": 126, "rele": "bomba|nutri|luz|vent", "acao": "ligar|desligar", "dur_s": 600}
```

- `ligar` sobrepõe o automático **daquele relé** por `dur_s` segundos (máximo
  3600; ausente ou ≤ 0 vira 60).
- `desligar` encerra a sobreposição e **devolve o relé ao automático** — não é
  "forçar desligado". Um `desligar` na `luz` dentro do fotoperíodo deixa a luz
  acesa, porque é isso que o automático manda.
- Expirado o `dur_s`, o relé volta ao automático sozinho.

### Limites que nenhum comando fura

| Relé | Limite |
|---|---|
| `bomba` | `dur_s` é cortado em `MAX_BOMBA` (hoje 50 s = `REGA_ENCHE` 20 s + 2 x `REGA_DOSE` 15 s), e a bomba **não liga** com `umidade: null` |
| `nutri` | `dur_s` é cortado no que resta dos 30 s do dia; sem margem, o comando é ignorado |

### Ciclo de vida / `acks`

1. O servidor manda o comando em `comandos`.
2. A placa executa e guarda o `id`.
3. Na telemetria seguinte, o `id` vem em `acks`.
4. O servidor marca como confirmado e **para de mandar**.

Enquanto não vier o ack, **reenvie o comando**. A placa guarda os últimos 16
ids e ignora repetição, mas manda o ack de novo — então reenviar é seguro.

Atenção: a placa manda ack **mesmo quando recusa** o comando (relé
desconhecido, ação inválida, sem margem no limite diário). Ack quer dizer
"recebi e resolvi", não "liguei". Quem confirma se ligou é o campo `reles` da
telemetria.

---

## `POST /api/device/foto`

**Quem chama:** ESP32-CAM, a cada 30 min.

**Headers**

| Header | Valor |
|---|---|
| `Content-Type` | `image/jpeg` |
| `X-Device-Key` | a `DEVICE_KEY` compartilhada |
| `X-Captured-At` | epoch **UTC** em segundos, ou `0` se o NTP falhou |
| `X-Fw` | ex. `cam-1.0.0` |

**Corpo:** o JPEG puro. **Não é multipart.** SVGA 800×600 com qualidade 12 dá
mais ou menos 40–90 kB.

**Resposta esperada:** `200` com `{"ok": true}`.

Qualquer outra resposta: a placa loga e **dorme normalmente, sem reenviar**. A
próxima foto vem em 30 min. Perder uma foto é aceitável; ficar acordada
tentando reenviar gasta bateria e atrasa o ciclo.

### Juntando foto e leitura

A CAM não manda id de estação — ela não sabe qual é. Use a `DEVICE_KEY` para
descobrir a estação e casa a foto com a telemetria mais recente daquela
estação. Como as duas placas rodam em relógios independentes, use
`X-Captured-At` para achar a leitura mais próxima, e não "a última".

Com `X-Captured-At: 0` você não tem hora confiável da captura — vale salvar a
foto com a hora de chegada e marcar que o timestamp é do servidor.

### Janela de foto

O LED Grow é roxo e falsearia a análise de amarelamento. Por isso o ESP32
principal apaga a luz numa janela combinada, e a CAM fotografa dentro dela com
o próprio flash:

- a cada **30 min**, no minuto exato (`:00` e `:30`);
- luz apagada por **40 s**;
- a CAM captura **15 s** depois do início da janela.

As três constantes vivem em [shared/protocolo.h](shared/protocolo.h) e valem
para as duas placas. **Mudou uma, regrave as duas** — senão a foto sai com a
luz acesa.

---

## Segurança

**O que a `DEVICE_KEY` pode fazer.** Só as duas rotas deste arquivo. Ela não dá
acesso a conta de usuário, não lista estações de terceiros e não lê relatório.
No backend, resolva a estação *a partir da chave* — nunca aceite um `estacao_id`
que venha no corpo, senão uma placa poderia escrever na estação de outro.

**HTTPS sem validar certificado.** As duas placas chamam `setInsecure()`: o
tráfego é criptografado, mas o certificado do servidor não é verificado. O
bundle de CAs do core ESP32 exige `board_build.embed_files` +
`setCACertBundle()`, custa uns 64 kB de flash e quebra a cada troca de versão
do core.

Risco aceito: quem já estiver dentro da rede pode se passar pelo servidor e ver
a telemetria e a chave. Para um TCC, com a chave sem poder nenhum sobre contas,
é aceitável. Se quiser fechar isso depois, o caminho é fixar o certificado da
Vercel com `setCACert()` e o PEM da raiz — mas aí a placa precisa ser regravada
quando o certificado rodar.

**Limites são locais, de propósito.** O backend não consegue mandar a bomba
ficar ligada 10 minutos, nem dosar 2 minutos de nutriente. Mesmo que a resposta
mande, o firmware corta. Isso é intencional: um bug no backend, ou uma resposta
adulterada, não deve afogar a planta.

---

## Testando sem o backend

O [tools/mock-server.js](tools/mock-server.js) implementa este contrato inteiro
em Node puro. Como usar está no [README.md](README.md).
