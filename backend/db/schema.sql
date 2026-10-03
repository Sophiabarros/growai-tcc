-- GrowAI (TrackLink) - schema PostgreSQL
-- Rode com: npm run db:schema  (ou psql $DATABASE_URL -f db/schema.sql)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stations (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  plant             TEXT NOT NULL,
  tag               TEXT,
  water_interval_h  NUMERIC NOT NULL DEFAULT 8,
  light_hours       NUMERIC NOT NULL DEFAULT 12,
  humidity_target   NUMERIC NOT NULL DEFAULT 70,
  ph_target         NUMERIC NOT NULL DEFAULT 6.5,
  -- Config do firmware que o app ainda nao edita em tela (ver
  -- services/configDispositivo.js). cfg_versao comeca em 1 porque o firmware
  -- nasce em 0: a primeira telemetria de uma placa nova ja recebe a config.
  luz_inicio        TIME    NOT NULL DEFAULT '06:00',
  vent_min_por_hora INTEGER NOT NULL DEFAULT 10,
  temp_max          NUMERIC NOT NULL DEFAULT 30,
  nutri_hora        TIME    NOT NULL DEFAULT '08:00',
  nutri_s           INTEGER NOT NULL DEFAULT 8,
  cfg_versao        INTEGER NOT NULL DEFAULT 1,
  -- false = a IA so sugere, nao aplica sozinha (ver services/autoAjuste.js)
  ia_autoajuste      BOOLEAN NOT NULL DEFAULT true,
  rotina_avaliada_em TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- humidity/ph/light_h/temperature aceitam NULL: nao existe sensor de pH nem
-- de luminosidade no projeto, e sensor com defeito manda null. Zero seria uma
-- leitura valida e mentiria no relatorio.
CREATE TABLE IF NOT EXISTS sensor_readings (
  id           SERIAL PRIMARY KEY,
  station_id   INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  humidity     NUMERIC,
  ph           NUMERIC,
  light_h      NUMERIC,
  temperature  NUMERIC,
  estado       TEXT,
  reles        JSONB,
  extra        JSONB,   -- payload cru da placa: umidade_bruto, rssi, uptime_s, erro...
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sensor_readings_station_time
  ON sensor_readings (station_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS station_photos (
  id             SERIAL PRIMARY KEY,
  station_id     INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  image_url      TEXT NOT NULL,
  health_status  TEXT NOT NULL CHECK (health_status IN ('saudavel', 'atencao', 'indefinido')),
  analysis_text  TEXT NOT NULL,
  sensor_snapshot JSONB,  -- a leitura que foi junto para a IA
  ia_raw          JSONB,  -- o que a IA respondeu, cru (rastro para o TCC)
  captured_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_station_photos_station_time
  ON station_photos (station_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS suggestions (
  id           SERIAL PRIMARY KEY,
  station_id   INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  message      TEXT NOT NULL,
  growth_pct   NUMERIC NOT NULL,
  health_pct   NUMERIC NOT NULL,
  applied      BOOLEAN NOT NULL DEFAULT false,
  config          JSONB,  -- ajustes propostos pela IA (humidity_target, light_hours...)
  config_anterior JSONB,  -- valores de antes: e o que permite desfazer
  auto_aplicada   BOOLEAN NOT NULL DEFAULT false,
  desfeita_em     TIMESTAMPTZ,
  -- ia_foto = da analise visual | ia_rotina = da avaliacao da rotina | manual
  origem       TEXT NOT NULL DEFAULT 'ia_foto'
               CHECK (origem IN ('ia_foto', 'ia_rotina', 'manual')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_suggestions_auto
  ON suggestions (station_id, created_at DESC) WHERE auto_aplicada = true;

-- Uma linha por placa ESP32. A chave em texto puro NUNCA e guardada: so o
-- sha256 em hex. Gere com scripts/criar-dispositivo.js.
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

-- Fila de comandos manuais. O servidor nao consegue chamar a placa, entao o
-- comando espera aqui ate ela pedir a proxima telemetria.
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
CREATE INDEX IF NOT EXISTS idx_commands_pendentes ON commands (station_id, status)
  WHERE status IN ('pendente', 'enviado');

CREATE TABLE IF NOT EXISTS notification_settings (
  user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  health_alerts     BOOLEAN NOT NULL DEFAULT true,
  watering_updates  BOOLEAN NOT NULL DEFAULT true,
  weekly_reports    BOOLEAN NOT NULL DEFAULT false
);

-- Tokens de "esqueci minha senha". Só o hash SHA-256 do token é guardado; o
-- token em texto puro vai apenas no e-mail. Expira em expires_at e só vale
-- uma vez (used_at). O backend também cria esta tabela sozinho na primeira
-- utilização (services/passwordReset.js), então rodar este arquivo é opcional.
CREATE TABLE IF NOT EXISTS password_resets (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
