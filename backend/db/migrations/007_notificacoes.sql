-- GrowAI - migração 007: notificações (o sino do app)
--
-- Até aqui o sino era só desenho: só existiam as PREFERÊNCIAS
-- (notification_settings). Cada aviso gerado pelo backend fica aqui, e o
-- sino lista tudo o que a pessoa recebeu. Quem cria: services/notificacoes.js.
--
-- Idempotente, como as anteriores.

BEGIN;

CREATE TABLE IF NOT EXISTS notificacoes (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  station_id  INTEGER REFERENCES stations(id) ON DELETE CASCADE,
  -- saude, praga, luz, ajuste, rega, sensor, placa, relatorio
  tipo        TEXT    NOT NULL,
  titulo      TEXT    NOT NULL,
  mensagem    TEXT,
  lida        BOOLEAN NOT NULL DEFAULT false,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notificacoes_user ON notificacoes (user_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_notificacoes_dedupe ON notificacoes (user_id, station_id, tipo, criado_em DESC);

COMMIT;
