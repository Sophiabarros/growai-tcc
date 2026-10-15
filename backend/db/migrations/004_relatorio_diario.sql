-- GrowAI - migração 004: resumo diário para os relatórios
--
-- Os gráficos de Relatórios eram calculados na hora, das tabelas brutas. Só
-- que as fotos são apagadas depois de ~300 por estação (uns 6 dias) e as
-- leituras de 1 por minuto enchem o banco gratuito. Esta tabela guarda UM
-- resumo por estação por dia, para sempre: é dela que sai o relatório
-- semanal (e qualquer período mais longo no futuro). services/relatorios.js
-- recalcula o dia de hoje e o de ontem a cada 10 min.
--
-- Idempotente, como as anteriores.

BEGIN;

CREATE TABLE IF NOT EXISTS relatorio_diario (
  station_id        INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  dia               DATE    NOT NULL,          -- dia no fuso de São Paulo

  -- Saúde: das fotos ANALISADAS pela IA ('indefinido' fica fora da conta).
  fotos_analisadas  INTEGER NOT NULL DEFAULT 0,
  fotos_saudaveis   INTEGER NOT NULL DEFAULT 0,
  fotos_atencao     INTEGER NOT NULL DEFAULT 0,
  saude_pct         INTEGER,                   -- NULL = nenhuma foto analisada no dia

  -- Ambiente: das leituras da placa principal.
  leituras          INTEGER NOT NULL DEFAULT 0,
  umidade_media     NUMERIC,
  umidade_min       NUMERIC,
  umidade_max       NUMERIC,
  temp_media        NUMERIC,
  temp_min          NUMERIC,
  temp_max          NUMERIC,

  -- Tempo ligado no dia, por relé (o maior contador do dia; main-1.4.0+).
  luz_s             INTEGER,
  uv_s              INTEGER,
  bomba_s           INTEGER,
  nutri_s           INTEGER,

  atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (station_id, dia)
);

CREATE INDEX IF NOT EXISTS idx_relatorio_diario_dia ON relatorio_diario (dia);

-- As consultas por dia em sensor_readings e station_photos usam estes.
CREATE INDEX IF NOT EXISTS idx_sensor_readings_station_time ON sensor_readings (station_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_station_photos_station_time ON station_photos (station_id, captured_at);

COMMIT;
