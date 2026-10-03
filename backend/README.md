# GrowAI API

Backend do GrowAI (produto da TrackLink) — Node.js + Express + PostgreSQL.

As leituras são **reais**: vêm das placas ESP32 por `POST /api/device/telemetria`
(ver [Placas ESP32](#placas-esp32)). O `services/mockSensor.js` só é usado com
`MOCK_SENSOR=1`, para mexer no layout do app sem placa ligada.

## Estrutura

```
backend/
  server.js              ponto de entrada, monta rotas e middlewares
  config/db.js            pool de conexão PostgreSQL
  middleware/auth.js       valida JWT (requireAuth)
  middleware/deviceAuth.js valida X-Device-Key das placas (sha256 no banco)
  services/mockSensor.js   leituras simuladas (só com MOCK_SENSOR=1)
  services/configDispositivo.js  traduz a estação na config do firmware + cfg_versao
  services/ia.js           análise visual das fotos (Gemini ou Claude, via fetch)
  services/iaPrompt.js     o prompt e o esquema JSON da resposta
  controllers/             lógica de cada recurso
  routes/                  mapeamento HTTP -> controller
  db/schema.sql            criação das tabelas (instalação nova)
  db/migrations/           migrações incrementais, idempotentes
  db/migrate.js            runner das migrações (npm run db:migrate)
  db/seed.sql               dados de demonstração (usuário demo@growai.com / senha123)
  scripts/criar-dispositivo.js  gera a chave de uma placa
  scripts/simular-horta.js      simula as duas placas contra a API
```

## Setup

1. **Instalar dependências**
   ```
   cd backend
   npm install
   ```

2. **Configurar variáveis de ambiente**
   ```
   cp .env.example .env
   ```
   Edite `.env` com a `DATABASE_URL` do seu Postgres (local, Docker ou um serviço
   gratuito como Neon/Supabase/Railway) e um `JWT_SECRET` próprio. Para o formulário
   de contato funcionar, preencha também `RESEND_API_KEY` com uma chave gerada em
   https://resend.com/api-keys (o remetente usado é o sandbox `onboarding@resend.dev`,
   que só entrega para o e-mail da própria conta Resend).

3. **Criar as tabelas**

   Instalação nova (precisa do `psql` no PATH):
   ```
   npm run db:schema
   ```

   Banco que já existe, ou máquina sem `psql` (o caso do Windows com Node):
   ```
   npm run db:migrate:dry    # mostra o que seria aplicado
   npm run db:migrate        # aplica
   ```
   As migrações de `db/migrations/` são idempotentes (`IF NOT EXISTS`,
   `DROP NOT NULL`): rodar duas vezes não quebra nem perde dado. O runner é
   Node + `pg`, então não depende do `psql`.

4. **(Opcional) Popular com dados de demonstração**
   ```
   npm run db:seed
   ```
   Cria o usuário `demo@growai.com` / `senha123` com as duas estações (Camomila
   e Hortelã) e sugestões já usadas nas telas do app.

5. **Rodar em desenvolvimento**
   ```
   npm run dev
   ```
   API sobe em `http://localhost:3000`.

## Rotas

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| GET | `/api/health` | não | healthcheck |
| POST | `/api/contact` | não | envia e-mail do formulário "Contate-nos" via Resend |
| POST | `/api/auth/register` | não | cria usuário |
| POST | `/api/auth/login` | não | retorna `{ user, token }` |
| GET | `/api/auth/me` | sim | usuário logado |
| GET | `/api/stations` | sim | lista estações |
| POST | `/api/stations` | sim | cria estação |
| GET | `/api/stations/:id` | sim | detalhe |
| PUT | `/api/stations/:id` | sim | edita rotina + config do firmware; sobe `cfg_versao` |
| DELETE | `/api/stations/:id` | sim | remove estação |
| GET | `/api/stations/:id/readings/latest` | sim | **última leitura real** + `online` + `reles`; `404` se não houver |
| GET | `/api/stations/:id/photos/latest` | sim | última foto **analisada** + status de saúde |
| GET | `/api/reports/weekly` | sim | série semanal: `health` = % de fotos `saudavel`/dia, `environment` = umidade média/dia |
| GET | `/api/suggestions` | sim | lista sugestões de otimização |
| PATCH | `/api/suggestions/:id/apply` | sim | marca como aplicada **e aplica o `config` na estação** (mesma transação) |
| PATCH | `/api/suggestions/:id/undo` | sim | desfaz um ajuste que a IA aplicou sozinha |
| POST | `/api/stations/:id/commands` | sim | cria comando manual `{rele, acao, dur_s}` |
| GET | `/api/stations/:id/commands` | sim | últimos 20 comandos |
| GET | `/api/stations/:id/devices` | sim | placas da estação (sem o hash) + `online` |
| POST | `/api/stations/:id/avaliar-rotina` | sim | IA julga a rotina contra a espécie e a finalidade (sem foto) |
| POST | `/api/device/telemetria` | `X-Device-Key` | telemetria da placa `main`; responde config + comandos |
| POST | `/api/device/foto` | `X-Device-Key` | JPEG puro da placa `cam`; chama a IA e grava |
| GET | `/api/settings/notifications` | sim | preferências de notificação |
| PATCH | `/api/settings/notifications` | sim | atualiza preferências |

Rotas autenticadas esperam header `Authorization: Bearer <token>`.
As duas rotas `/api/device/*` **não** usam JWT: usam `X-Device-Key` e não passam
por `requireAuth`. O contrato completo delas está em
[`../firmware/PROTOCOLO.md`](../firmware/PROTOCOLO.md) — ele e este backend
precisam continuar iguais.


## Placas ESP32

As placas não fazem login. Cada uma tem uma chave própria em `X-Device-Key`, e o
banco guarda **só o sha256** dela (mesmo esquema de `password_resets`). A estação
é descoberta a partir da chave — nunca de um `station_id` no corpo, senão uma
placa conseguiria escrever na estação de outro usuário.

São **duas chaves por estação**, uma por placa:

| Placa | `tipo` | Rota que a chave abre |
|---|---|---|
| ESP32 comum | `main` | `POST /api/device/telemetria` |
| ESP32-CAM | `cam` | `POST /api/device/foto` |

Chave certa na rota errada responde `401` igual a chave inexistente.

### Cadastrar as placas

```
npm run criar-dispositivo -- <station_id> main "ESP32 principal"
npm run criar-dispositivo -- <station_id> cam  "ESP32-CAM"
```

Cada execução imprime a chave **uma única vez**. Copie na hora e cole no
`secrets.h` da placa (ver [`../firmware/README.md`](../firmware/README.md)).
Não existe recuperar: perdeu, rode de novo e a antiga para de valer.

Para descobrir o `station_id`, rode o script com um id inválido — ele lista as
estações existentes com o e-mail do dono.

### Como a config chega à placa

O app só edita `humidity_target` e `light_hours`. O resto é derivado em
`services/configDispositivo.js`:

| Campo do firmware | De onde vem |
|---|---|
| `umid_liga` | `humidity_target − 10`, limitado a 15–80 |
| `umid_desliga` | `humidity_target + 5`, limitado a (`umid_liga`+5)–95 |
| `luz_on` | `luz_inicio` |
| `luz_off` | `luz_inicio + light_hours`, **reduzido a 00:00–23:59** |
| `vent_min_por_hora`, `temp_max`, `nutri_hora`, `nutri_s` | direto da estação |

O módulo 24 h no `luz_off` não é detalhe: 18:00 + 10 h daria `"28:00"`, e o
firmware **recusa a config inteira** quando a hora é inválida — a mudança
simplesmente não pegaria, sem erro visível. Reduzido, `"04:00"` é lido como
fotoperíodo que atravessa a meia-noite.

Toda alteração desses campos (em `PUT /stations/:id` ou ao aplicar uma sugestão)
faz `cfg_versao + 1`. A placa manda a versão que tem; se diferir, a resposta da
telemetria já leva a config nova.

### Comandos manuais

`POST /api/stations/:id/commands` com `{rele, acao, dur_s}` cria um comando
`pendente`. A placa pega na próxima telemetria (~15 s), executa e confirma no
ciclo seguinte — **não é instantâneo**.

Os limites de segurança de verdade são do firmware e não dependem do backend:
bomba no máximo 20 s por acionamento, nutriente no máximo 30 s por dia. Um
`dur_s: 600` na bomba é aceito aqui e **cortado para 20 s pela placa**.
Comando sem ack em 10 min vira `expirado`, para uma placa que voltou de uma hora
offline não executar um "ligar a bomba" velho.

### Simular as placas

```
DEVICE_KEY_MAIN=<chave main> DEVICE_KEY_CAM=<chave cam> npm run simular
```

Opções: `--foto-a-cada N` (minutos, 0 desliga), `--ciclos N`, `--intervalo N`.
Ponha uns `.jpg` de planta em `scripts/amostras/` (ver o `LEIA-ME.txt` de lá).

O simulador obedece a config e os comandos que o backend manda, e reproduz os
limites do firmware — dá para ver a histerese funcionando e o `dur_s` sendo
cortado.

## IA (análise visual das fotos)

`POST /api/device/foto` chama a IA **na mesma requisição**, junta a foto com a
última leitura da estação e grava tudo.

| Variável | Para quê |
|---|---|
| `IA_PROVIDER` | `gemini` (padrão) ou `claude` |
| `IA_HABILITADA` | `false` salva como `indefinido` sem chamar a IA |
| `IA_TIMEOUT_MS` | padrão 25000 |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | provedor Gemini (padrão `gemini-3.6-flash`) |
| `ANTHROPIC_API_KEY`, `CLAUDE_MODEL` | provedor Claude |

Sem SDK: as duas usam o `fetch` nativo do Node 22.

### Escolha do modelo: não use os "lite"

Testado com fotos reais em 02/10/2026:

| Modelo | Foto saudável | Foto preta (luminância 15/255) |
|---|---|---|
| `gemini-3.6-flash` | `saudavel`, ~5 s | `atencao`, "a imagem está muito escura" ✅ |
| `gemini-3.5-flash-lite` | `saudavel`, ~2 s | **`saudavel`**, "folhagem verde vibrante, flores bem formadas" ❌ |
| `gemini-3.1-flash-lite` | `saudavel` | **`saudavel`**, mesma alucinação ❌ |

Os modelos `lite` **inventam** uma planta saudável numa imagem onde não se vê
nada, em vez de seguir a regra do prompt e pedir outra foto. Isso é pior que não
ter análise: se o flash da CAM queimar, ou a janela de foto desencontrar e a
imagem sair escura, o app diria "tudo bem" para uma planta que ninguém está
vendo. Fique nos modelos sem `-lite`.

O `gemini-3.8-flash` (o mais novo) deu `503 high demand` e timeout de forma
intermitente nos testes. O `3.6-flash` respondeu em 5–7 s de forma consistente —
daí o padrão. Se o 3.8 estabilizar, é só trocar `GEMINI_MODEL`.

Para listar os modelos que a sua chave acessa:

```bash
node -e "require('dotenv').config();fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100',{headers:{'x-goog-api-key':process.env.GEMINI_API_KEY}}).then(r=>r.json()).then(j=>(j.models||[]).filter(m=>(m.supportedGenerationMethods||[]).includes('generateContent')).forEach(m=>console.log(m.name)))"
```

### maxOutputTokens tem que ser alto

Está em 4096 para um JSON de ~150 caracteres, e isso é de propósito: os modelos
Gemini 3.x gastam orçamento de **saída** com raciocínio interno antes de escrever
a resposta. Com 800 o modelo era cortado no meio e voltava `finishReason:
MAX_TOKENS` sem JSON nenhum, e toda foto virava `indefinido`. Só o que ele
realmente escreve é cobrado, então o teto alto não custa.

**Nada que a IA devolve entra no banco sem passar por `validarResposta()`.** JSON
fora do formato conta como falha; valor de config fora do limite é cortado para o
limite; `analysis_text` é truncado em 200 caracteres.

**Falhar é caminho normal.** Se a IA cair, demorar ou responder torto, a foto é
gravada com `health_status = 'indefinido'` e
`analysis_text = 'Análise indisponível no momento.'`, e a resposta é `200` — a
placa não reenvia foto. O app mostra "Sem análise", sem ícone de alerta. O motivo
exato fica em `station_photos.ia_raw.motivo`.

As colunas `sensor_snapshot` e `ia_raw` guardam o que a IA recebeu e respondeu,
para o TCC poder mostrar isso sem depender de log do servidor.

**Retenção:** as últimas 300 fotos por estação; as mais antigas são apagadas. A
foto vira data URL em `station_photos.image_url`, porque o disco da Vercel é
somente leitura (mesmo esquema do avatar).


## A IA avalia a rotina e se ajusta sozinha

Além de analisar a foto, a IA avalia se a **rotina** faz sentido para a espécie e
para a **finalidade** declarada (o campo `tag` da estação: "Anti-inflamatória",
"Calmante"...). A finalidade diz qual parte da planta interessa — flor, folha,
raiz — e daí o que a rotina deveria favorecer.

Exemplo real do teste: camomila com 8 h de luz.

```
health_status : atencao
analysis_text : "O fotoperíodo de 8 horas de luz é insuficiente para induzir a
                 floração da camomila, que necessita de dias longos para florescer."
sugestão      : light_hours 8 -> 14   (aplicada automaticamente)
```

### Dois gatilhos

| Quando | Rota | Manda foto? |
|---|---|---|
| Chega foto da CAM | `POST /api/device/foto` | sim, analisa a imagem |
| Usuário salva a rotina | `POST /api/stations/:id/avaliar-rotina` | **não**, julga só os números |

A avaliação de rotina é chamada por `js/station-modal.js` depois de salvar, **sem
`await`**: ela leva ~6 s e o salvamento tem que fechar na hora. O resultado
aparece depois, na tela Relatórios.

### O ajuste automático e o desfazer

Quando a IA propõe uma mudança, `services/autoAjuste.js` aplica na estação,
sobe `cfg_versao` (para a placa receber) e guarda em `suggestions.config_anterior`
os valores de antes. Tudo numa transação.

O card em Relatórios mostra o que ela fez (`umidade alvo: 70 → 85`) e um botão
**Desfazer ajuste**, que restaura os valores anteriores e sobe a versão de novo.

Três travas impedem o ajuste automático. Quando uma delas atua, a sugestão
**ainda é gravada** — só fica esperando o usuário aplicar no botão:

| Trava | Variável |
|---|---|
| `stations.ia_autoajuste = false` na estação | — |
| A IA já ajustou esta estação há menos de 6 h | `IA_AUTOAJUSTE_COOLDOWN_H` |
| A IA não propôs mudança de parâmetro (só um recado) | — |

O cooldown não é detalhe: sem ele, uma foto a cada 30 min poderia virar 48
mudanças de rotina por dia e a planta nunca estabilizaria em nada.

**Segurança física não depende disso.** O limite de 20 s de bomba e 30 s de
nutriente por dia está no firmware. O pior que um ajuste errado da IA faz é a
planta receber mais ou menos água do que devia — nunca afogar.

### O que a IA não pode dizer

O prompt a proíbe de afirmar qualquer coisa sobre **concentração de princípio
ativo, potência medicinal ou efeito terapêutico**. Ela conecta a finalidade à
rotina pelo lado hortícola ("camomila se usa pela flor, então priorize
floração"), nunca pelo farmacológico ("essa rotina deixa sua camomila mais
calmante"). Isso não se mede por foto nem por umidade, e numa banca seria o
primeiro ponto a ser derrubado.

### Cota da API: por que a análise é espaçada

A cota gratuita do Gemini é de **20 requisições por dia por modelo**. A CAM manda
**48 fotos por dia por estação**. Analisar todas estoura a cota antes do
meio-dia e o resto do dia fica sem análise nenhuma.

Por isso `IA_FOTO_INTERVALO_MIN` (padrão 180 min) espaça as **análises**, não as
fotos: toda foto é guardada, mas só uma a cada 3 h é analisada — 8 por dia por
estação, com folga para as avaliações de rotina.

Como consequência, a foto mais recente geralmente não tem diagnóstico. Então
`GET /stations/:id/photos/latest` devolve a última foto **analisada**, não a
última foto, senão a tela Câmera ficaria quase sempre em "Sem análise" com a
análise boa escondida no histórico.

Com cota paga, baixe `IA_FOTO_INTERVALO_MIN` para 30 e todas serão analisadas.

## Próximos passos sugeridos

- **Botões de controle manual no app.** A API (`POST /stations/:id/commands`) e o
  wrapper (`GrowAI.createCommand`) estão prontos, mas nenhuma tela tem botão
  ligado nisso ainda. O lugar mais natural é a tela **Estações**, no card de cada
  estação: "Regar agora" (bomba, 20 s), "Ventilar" (vent, 300 s) e "Luz" — com o
  estado atual vindo do campo `reles` de `readings/latest`. A tela Câmera seria a
  segunda opção, já que é lá que se vê a planta.
- **Mover as fotos para armazenamento de objeto** (Vercel Blob, S3, Cloudinary).
  Hoje cada foto é uma data URL de ~60-120 kB dentro da linha do Postgres; 300
  fotos por estação são uns 30 MB de banco por estação.
- **Histórico de fotos na tela Câmera** — o botão "Ver histórico de imagens" já
  existe no layout e ainda não abre nada.
- Alertas/notificações a partir de `health_status = 'atencao'` (a tabela
  `notification_settings` já existe e ninguém a consome).
