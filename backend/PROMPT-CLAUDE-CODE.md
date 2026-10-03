# Tarefa: conectar o backend e o app do GrowAI às placas e à IA

Este repositório (`tcc/`) é o meu TCC, o **GrowAI**, um sistema semi-hidropônico com IoT e IA para plantas medicinais. Ele tem:

- **Site/app:** HTML/CSS/JS puro na raiz. As páginas do app são `app-*.html` e falam com a API por `js/api.js`.
- **Backend:** `backend/`, com Express + PostgreSQL (Neon), JWT e deploy serverless na Vercel em `https://growai-backend.vercel.app/api`.

Hoje as leituras do app são **simuladas** (`backend/services/mockSensor.js`). O hardware já está pronto: um ESP32 comum (sensores e 4 relés) e um ESP32-CAM. O objetivo desta tarefa é **deixar tudo conectado de verdade**: placas → backend → IA → banco → app.

O firmware é outra tarefa (`firmware/PROMPT-CLAUDE-CODE.md`). **O contrato HTTP abaixo precisa ser idêntico ao daquele arquivo**; leia a seção 6 dele antes de começar.

Código e comentários em **português**, no mesmo estilo do backend atual (controllers, routes e services simples, sem ORM). Leia `backend/README.md`, `server.js`, `db/schema.sql` e os controllers antes de mexer.

---

## Regras

1. **Não quebre nada que já funciona:** login, cadastro, recuperação de senha, estações, relatórios, sugestões, configurações e o formulário de contato.
2. **Banco de produção:** o `DATABASE_URL` do `.env` provavelmente aponta para o Neon de produção. Escreva a migração **idempotente** (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP NOT NULL`) e **me mostre o SQL e peça confirmação antes de executar** no banco.
3. **Segredos:** nunca escreva chaves em arquivos versionados. As variáveis novas vão para `backend/.env` (que já está no `.gitignore`) e, **sem valor**, para `backend/.env.example`.
4. **Não faça `git push` nem deploy sem me perguntar.** No fim, me diga exatamente o que cadastrar na Vercel.
5. Se algo aqui for impossível ou arriscado, pergunte antes de mudar a arquitetura.

## Arquitetura (já decidida)

- A Vercel é serverless: **sem WebSocket e sem o servidor chamar a placa**. As placas sempre iniciam a requisição por HTTP(S).
- **ESP32 comum:** `POST /api/device/telemetria` a cada ~15 s. **A resposta** traz a config nova (se mudou) e os comandos manuais pendentes.
- **ESP32-CAM:** `POST /api/device/foto` a cada 30 min, com o corpo em JPEG puro. **Na mesma requisição, o backend chama a IA**, junta a foto com a última leitura da estação e grava o resultado.
- As placas se autenticam com `X-Device-Key` (uma chave por placa, guardada como hash no banco). **Não usam o JWT do usuário.**
- A segurança física (tempo máximo de bomba, histerese, limite diário de nutrientes) fica **no firmware**. O backend também valida e limita tudo que envia.

## 1. Migração do banco

Crie `backend/db/migrations/001_dispositivos.sql` e atualize também `db/schema.sql`, para uma instalação nova já sair completa.

- **`devices`**:
  - `id`, `station_id` (FK com CASCADE), `tipo` (`'main'` ou `'cam'`), `nome`;
  - `key_hash` (sha256 em hex, UNIQUE), `fw`, `last_seen` (timestamptz), `created_at`.
- **`sensor_readings`**:
  - `humidity`, `ph`, `light_h` e `temperature` passam a aceitar `NULL`. Não há sensor de pH nem de luminosidade, e sensor com defeito manda `null`;
  - novas colunas `estado TEXT`, `reles JSONB` e `extra JSONB` (guarda o payload bruto: `umidade_bruto`, `rssi`, `uptime_s`, `erro`, etc.).
- **`stations`**: novas colunas com defaults:
  - `luz_inicio TIME '06:00'`, `vent_min_por_hora INT 10`, `temp_max NUMERIC 30`;
  - `nutri_hora TIME '08:00'`, `nutri_s INT 8`, `cfg_versao INT 1`.
- **`commands`**:
  - `id`, `station_id`, `rele` (`bomba|nutri|luz|vent`), `acao` (`ligar|desligar`), `dur_s`;
  - `origem` (`manual|ia`), `status` (`pendente|enviado|confirmado|expirado`);
  - `created_at`, `sent_at`, `acked_at`.
- **`station_photos`**:
  - `health_status` passa a aceitar também `'indefinido'` (para quando a IA falhar);
  - novas colunas `sensor_snapshot JSONB` e `ia_raw JSONB`, para rastrear no TCC o que a IA recebeu e respondeu.
- **`suggestions`**: nova coluna `config JSONB` com os ajustes propostos pela IA.

Adicione `npm run db:migrate` no `package.json`, no mesmo estilo dos scripts existentes.

## 2. Config da estação → config do firmware

O app já edita `humidity_target` e `light_hours`. **Não crie campos novos na interface para isso**; derive no backend:

- `umid_liga = humidity_target − 10` e `umid_desliga = humidity_target + 5`. Limite `umid_liga` a 15–80 e `umid_desliga` a (`umid_liga` + 5)–95.
- `luz_on = luz_inicio` e `luz_off = luz_inicio + light_hours`.
- `vent_min_por_hora`, `temp_max`, `nutri_hora` e `nutri_s` vêm direto da estação.
- `nutri_s` fica entre 0 e 30, `temp_max` entre 15 e 45 e `vent_min_por_hora` entre 0 e 60.

**Toda alteração** desses campos (no `PUT /stations/:id` ou ao aplicar uma sugestão) faz `cfg_versao = cfg_versao + 1`. Centralize isso numa função `services/configDispositivo.js` (`montarConfig(station)` e `incrementarVersao(stationId)`).

## 3. Rotas das placas: `routes/device.js`, montada em `/api/device` sem `requireAuth`

- **`middleware/deviceAuth.js`**: lê `X-Device-Key`, calcula o sha256 e busca em `devices`. Se não achar, responde `401`. Se achar, preenche `req.device` e `req.station` e atualiza `last_seen` e `fw` (este vem do payload ou do header `X-Fw`).

### `POST /api/device/telemetria`

Aceita só placa `tipo='main'`. Payload e resposta exatamente como na seção 6 do prompt de firmware.

1. Grava a leitura em `sensor_readings`:
   - `humidity ← umidade`, `temperature ← temp_c`;
   - `ph = null`;
   - `light_h` = horas de luz programadas da estação;
   - `estado`, `reles` e `extra` com o restante.
2. Marca como `confirmado` os comandos cujos ids vieram em `acks`.
3. Comandos `pendente` com mais de 10 min viram `expirado`. Os demais pendentes vão na resposta e viram `enviado`.
4. Se o `cfg_versao` recebido for diferente do da estação, inclui `config` (via `montarConfig`).
5. Responde com `proxima_em_s: 15`.
6. Para o banco não crescer sem controle, grava no máximo **uma leitura por minuto** por estação. As outras só atualizam `last_seen` e o processamento de comandos. Explique essa decisão num comentário.

### `POST /api/device/foto`

Aceita só `tipo='cam'`. Corpo `image/jpeg` via `express.raw({ type: 'image/jpeg', limit: '2mb' })`, aplicado **só nessa rota**.

1. Valida que é um JPEG (bytes iniciais `FF D8`).
2. Busca a última leitura da estação e a estação (planta, config).
3. Chama `services/ia.js` (seção 4).
4. Grava em `station_photos`:
   - `image_url` como data URL `data:image/jpeg;base64,...`. O app já usa `image_url` direto no `<img>`, então funciona sem mexer no front; é o mesmo esquema do avatar, já que o disco da Vercel é somente leitura;
   - `health_status` e `analysis_text` da IA;
   - `sensor_snapshot`, `ia_raw` e `captured_at` (do header `X-Captured-At`; se vier `0`, usa `now()`).
5. Se a IA sugerir algo, grava em `suggestions` (`message`, `growth_pct`, `health_pct`, `config`).
6. **Retenção:** mantenha as últimas 300 fotos por estação e apague as mais antigas, para caber no plano gratuito do Neon.
7. **Se a IA falhar ou demorar**, grava a foto mesmo assim com `health_status='indefinido'` e `analysis_text='Análise indisponível no momento.'`, e responde `200`. A placa não reenvia.

**Atenção na Vercel:** o runtime Node da Vercel às vezes já consome o corpo da requisição. Confirme que `express.raw` recebe o JPEG inteiro no ambiente da Vercel (não só no `npm run dev`). Se não receber, resolva isso de forma robusta. Configure também em `backend/vercel.json` um `maxDuration` suficiente para a chamada da IA (60 s), conferindo se o plano Hobby permite.

## 4. IA: `services/ia.js`

- Interface: `analisar({ jpegBuffer, estacao, leitura, config }) → { health_status, analysis_text, suggestion }`.
- Provedor escolhido pela env `IA_PROVIDER`:
  - `gemini` (padrão): usa `GEMINI_API_KEY` e `GEMINI_MODEL`;
  - `claude`: usa `ANTHROPIC_API_KEY` e `CLAUDE_MODEL`.
  
  Use `fetch` nativo do Node 22, **sem instalar SDK**:
  - Gemini: endpoint `generateContent` da API `generativelanguage.googleapis.com`, header `x-goog-api-key`, imagem em `inline_data`, e `generationConfig` com `responseMimeType: "application/json"` e `responseSchema`.
  - Claude: Messages API, imagem em base64 e saída JSON.
  
  **Confira a documentação oficial atual** de cada API antes de escrever as requisições.
- `IA_HABILITADA=false` desliga a IA: as fotos são salvas como `indefinido`. Timeout de 25 s.
- **Prompt da IA** (escreva em português, num arquivo próprio `services/iaPrompt.js`):
  - Papel: especialista em fisiologia vegetal e cultivo semi-hidropônico de **plantas medicinais**.
  - Recebe: espécie da estação, leitura atual (umidade do substrato, temperatura), config atual (faixa de umidade, fotoperíodo, UV, ventilação, dose de nutrientes) e hora local.
  - Contexto: a foto é tirada **com a luz de cultivo apagada e flash branco**, então as cores são reais.
  - Tarefa: avaliar apenas **sinais visuais** (cor, murcha, manchas, pragas visíveis, vigor) e sugerir, só se fizer sentido, **um** ajuste ambiental dentro dos limites da seção 2.
  - Não inventar medições que não recebeu. Não afirmar nada sobre a concentração de princípios ativos.
  - Resposta em JSON:
    ```json
    {"health_status":"saudavel|atencao",
     "analysis_text":"até 200 caracteres, em português, para o usuário final",
     "suggestion": null | {"message":"...", "growth_pct":0-30, "health_pct":0-30,
                           "config": {"humidity_target"?, "light_hours"?, "vent_min_por_hora"?, "temp_max"?, "nutri_s"?}}}
    ```
- **Valide e limite a resposta no servidor.** Se o JSON vier inválido, trate como falha da IA. Qualquer valor de config fora dos limites é cortado para o limite. `analysis_text` é truncado em 200 caracteres.

## 5. Rotas do app (com JWT; conferir sempre que a estação é do usuário)

- **`GET /api/stations/:id/readings/latest`:** passa a devolver a **última leitura real** de `sensor_readings`. Mantenha o formato atual (`humidity`, `ph`, `light_h`, `temperature`, `recorded_at`) e acrescente `online` (último `last_seen` do main há menos de 60 s) e `reles`. Sem leitura, devolve `404`. Só use `mockSensor` se a env `MOCK_SENSOR=1`.
- **`POST /api/stations/:id/commands`:** body `{rele, acao, dur_s}`, valida e cria o comando `pendente` com `origem='manual'`.
- **`GET /api/stations/:id/commands`:** lista os últimos 20.
- **`GET /api/stations/:id/devices`:** lista as placas da estação (sem hash) com `last_seen` e `online`.
- **`PATCH /api/suggestions/:id/apply`:** além de marcar como aplicada, **aplica `suggestion.config` na estação** e incrementa `cfg_versao`, na mesma transação.
- **`PUT /api/stations/:id`:** passa a aceitar também `luz_inicio`, `vent_min_por_hora`, `temp_max`, `nutri_hora` e `nutri_s`, com os mesmos limites, e incrementa `cfg_versao` quando algo mudar.
- **Relatório semanal:** a série `health` passa a ser o **% de fotos `saudavel` por dia** (ignorando as `indefinido`); `environment` continua sendo a umidade média.

## 6. Ajustes no front (mínimos; não mude layout nem CSS sem me perguntar)

- `js/app-home.js`:
  - `humidity`, `temperature` ou `ph` `null` devem aparecer como `—`, não como `0%`/`NaN`. O card de pH mostra `—`, porque o projeto não tem sensor de pH.
  - Se `online` for falso, o status da estação mostra "Offline" em vez de "Online".
- `js/app-camera.js` e `js/app-home.js`: tratar `health_status='indefinido'` como neutro ("Sem análise"), sem ícone de alerta.
- **Controle manual:** se já existir um lugar adequado nas telas `app-*`, conecte os botões a `POST /stations/:id/commands`. **Se não existir, não crie UI nova:** só implemente a API e me diga onde sugeriria colocar os botões.
- **Não mude** `API_BASE` em `js/api.js`: ele continua apontando para produção.

## 7. Scripts de apoio (`backend/scripts/`)

- **`criar-dispositivo.js <station_id> <main|cam> [nome]`:** gera uma chave aleatória forte, grava só o hash e **imprime a chave uma única vez**, avisando que ela vai no `secrets.h` da placa.
- **`simular-horta.js`:** simula as duas placas contra `API_BASE` (env; padrão `http://localhost:3000/api`) usando chaves passadas por env.
  - Telemetria a cada 15 s com valores realistas: a umidade cai devagar e sobe quando a "bomba" liga.
  - Obedece `config` e `comandos` da resposta e manda os `acks`.
  - Envia uma foto de `scripts/amostras/*.jpg` a cada N minutos (`--foto-a-cada 5`).
  - Imprime tudo de forma legível. É com isso que eu testo o backend e o app sem as placas ligadas.
- Crie `scripts/amostras/LEIA-ME.txt` explicando que ali vão fotos JPEG de plantas para o simulador.

## 8. Critérios de pronto

- Migração revisada por mim e aplicada. Script `criar-dispositivo` testado, criando uma placa `main` e uma `cam` para a **Estação 1** do usuário demo.
- `npm run dev` + `simular-horta.js` rodando por alguns minutos sem erro:
  - leituras aparecem no app (`app-home.html` servido pelo Live Server, apontando para a API local para esse teste; **mude `API_BASE` só temporariamente e desfaça no fim**);
  - comando manual criado pela API chega ao simulador e volta confirmado;
  - aplicar uma sugestão faz a config nova chegar ao simulador;
  - com `GEMINI_API_KEY` configurada, a foto de amostra é analisada e aparece na tela Câmera.
- Teste com `curl`: chave errada → `401`; JPEG inválido → `400`; `dur_s` absurdo → `400`.
- `backend/README.md` atualizado com as rotas novas, as variáveis de ambiente e o passo a passo de cadastro das placas.
- No fim, me dê:
  - a lista das variáveis que preciso cadastrar na Vercel;
  - as duas chaves de dispositivo geradas (só na tela, não em arquivo);
  - os passos para eu fazer o deploy;
  - o que ficou pendente.
