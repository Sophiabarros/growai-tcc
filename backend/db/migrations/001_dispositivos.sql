-- GrowAI - migração 001: placas ESP32, comandos e rastro da IA
-- Rode com: npm run db:migrate  (ou psql $DATABASE_URL -f db/migrations/001_dispositivos.sql)
--
-- Idempotente de propósito: pode rodar duas vezes no mesmo banco sem erro e
-- sem perder dado. Nenhum comando aqui apaga coluna ou linha.

BEGIN;

-- ---------------------------------------------------------------- devices
-- Uma linha por placa. A chave em texto puro NUNCA é guardada: só o sha256
-- em hex, do mesmo jeito que password_resets.token_hash. Quem perde a chave
-- gera outra (scripts/criar-dispositivo.js).
CREATE TABLE IF NOT EXISTS devices (
  id          SERIAL PRIMARY KEY,
  station_id  INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  tipo        TEXT NOT NULL CHECK (tipo IN ('main', 'cam')),
  nome        TEXT,
  key_hash    TEXT NOT NULL UNIQUE,
  fw          TEXT,
  last_seen   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_devices_station ON devices (station_id);

-- ------------------------------------------------------- sensor_readings
-- Não existe sensor de pH nem de luminosidade no projeto, e sensor com
-- defeito manda null. As colunas passam a aceitar NULL para o backend não
-- ter que inventar zero (zero é uma leitura válida e mentiria no relatório).
ALTER TABLE sensor_readings ALTER COLUMN humidity    DROP NOT NULL;
ALTER TABLE sensor_readings ALTER COLUMN ph          DROP NOT NULL;
ALTER TABLE sensor_readings ALTER COLUMN light_h     DROP NOT NULL;
ALTER TABLE sensor_readings ALTER COLUMN temperature DROP NOT NULL;

ALTER TABLE sensor_readings ADD COLUMN IF NOT EXISTS estado TEXT;
ALTER TABLE sensor_readings ADD COLUMN IF NOT EXISTS reles  JSONB;
-- extra: o resto do payload cru da placa (umidade_bruto, rssi, uptime_s,
-- erro, erro_cfg, manual...). Fica em JSONB para não virar uma coluna nova a
-- cada campo que o firmware ganhar.
ALTER TABLE sensor_readings ADD COLUMN IF NOT EXISTS extra  JSONB;

-- -------------------------------------------------------------- stations
-- Config do firmware que o app ainda não edita em tela. O app continua
-- editando humidity_target e light_hours; o resto vive aqui com default.
ALTER TABLE stations ADD COLUMN IF NOT EXISTS luz_inicio        TIME    NOT NULL DEFAULT '06:00';
ALTER TABLE stations ADD COLUMN IF NOT EXISTS vent_min_por_hora INTEGER NOT NULL DEFAULT 10;
ALTER TABLE stations ADD COLUMN IF NOT EXISTS temp_max          NUMERIC NOT NULL DEFAULT 30;
ALTER TABLE stations ADD COLUMN IF NOT EXISTS nutri_hora        TIME    NOT NULL DEFAULT '08:00';
ALTER TABLE stations ADD COLUMN IF NOT EXISTS nutri_s           INTEGER NOT NULL DEFAULT 8;
-- cfg_versao começa em 1 (o firmware nasce em 0, então a primeira telemetria
-- de uma placa nova já recebe a config).
ALTER TABLE stations ADD COLUMN IF NOT EXISTS cfg_versao        INTEGER NOT NULL DEFAULT 1;

-- -------------------------------------------------------------- commands
-- Fila de comandos manuais. A placa não pode ser chamada pelo servidor, então
-- o comando espera aqui até ela pedir a próxima telemetria.
CREATE TABLE IF NOT EXISTS commands (
  id          SERIAL PRIMARY KEY,
  station_id  INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  rele        TEXT NOT NULL CHECK (rele IN ('bomba', 'nutri', 'luz', 'vent')),
  acao        TEXT NOT NULL CHECK (acao IN ('ligar', 'desligar')),
  dur_s       INTEGER,
  origem      TEXT NOT NULL DEFAULT 'manual' CHECK (origem IN ('manual', 'ia')),
  status      TEXT NOT NULL DEFAULT 'pendente'
              CHECK (status IN ('pendente', 'enviado', 'confirmado', 'expirado')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at     TIMESTAMPTZ,
  acked_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_commands_station_time ON commands (station_id, created_at DESC);
-- Busca da fila em cada telemetria: só as linhas ainda em aberto.
CREATE INDEX IF NOT EXISTS idx_commands_pendentes ON commands (station_id, status)
  WHERE status IN ('pendente', 'enviado');

-- -------------------------------------------------------- station_photos
-- 'indefinido' entra para quando a IA falhar ou estiver desligada: a foto é
-- guardada de qualquer jeito, só sem diagnóstico.
ALTER TABLE station_photos DROP CONSTRAINT IF EXISTS station_photos_health_status_check;
ALTER TABLE station_photos ADD CONSTRAINT station_photos_health_status_check
  CHECK (health_status IN ('saudavel', 'atencao', 'indefinido'));

-- sensor_snapshot: a leitura que foi junto para a IA.
-- ia_raw: o que a IA respondeu, cru. Os dois existem para o TCC poder mostrar
-- o que o modelo recebeu e devolveu, sem depender de log do servidor.
ALTER TABLE station_photos ADD COLUMN IF NOT EXISTS sensor_snapshot JSONB;
ALTER TABLE station_photos ADD COLUMN IF NOT EXISTS ia_raw          JSONB;

-- ----------------------------------------------------------- suggestions
-- config: os ajustes propostos pela IA, no formato aceito por
-- PATCH /suggestions/:id/apply (humidity_target, light_hours, ...).
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS config JSONB;

COMMIT;
