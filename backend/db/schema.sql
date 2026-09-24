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
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sensor_readings (
  id           SERIAL PRIMARY KEY,
  station_id   INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  humidity     NUMERIC NOT NULL,
  ph           NUMERIC NOT NULL,
  light_h      NUMERIC NOT NULL,
  temperature  NUMERIC NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sensor_readings_station_time
  ON sensor_readings (station_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS station_photos (
  id             SERIAL PRIMARY KEY,
  station_id     INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  image_url      TEXT NOT NULL,
  health_status  TEXT NOT NULL CHECK (health_status IN ('saudavel', 'atencao')),
  analysis_text  TEXT NOT NULL,
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
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
