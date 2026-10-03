-- GrowAI - migração 002: a IA avalia a rotina e se ajusta sozinha
--
-- Idempotente, como a 001. Nenhum comando aqui apaga coluna ou linha.

BEGIN;

-- ----------------------------------------------------------- suggestions
-- config_anterior: os valores que a estação tinha ANTES do ajuste da IA.
-- É o que torna o "desfazer" possível: sem isso, o usuário que discordasse do
-- ajuste automático teria que reconfigurar à mão sem saber o valor antigo.
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS config_anterior JSONB;

-- auto_aplicada: a IA aplicou sozinha (true) ou está esperando o usuário (false).
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS auto_aplicada BOOLEAN NOT NULL DEFAULT false;

-- desfeita_em: quando o usuário desfez. NULL = ainda valendo.
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS desfeita_em TIMESTAMPTZ;

-- origem: de onde saiu a sugestão.
--   ia_foto   = da análise visual de uma foto
--   ia_rotina = da avaliação da rotina contra a espécie e a finalidade
--   manual    = criada à mão (seed, testes)
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS origem TEXT NOT NULL DEFAULT 'ia_foto';

-- O CHECK vai separado do ADD COLUMN para a migração poder rodar duas vezes.
ALTER TABLE suggestions DROP CONSTRAINT IF EXISTS suggestions_origem_check;
ALTER TABLE suggestions ADD CONSTRAINT suggestions_origem_check
  CHECK (origem IN ('ia_foto', 'ia_rotina', 'manual'));

-- As sugestões que já existiam vieram do seed, não da IA.
UPDATE suggestions SET origem = 'manual' WHERE config IS NULL AND origem = 'ia_foto';

-- Busca do cooldown de auto-ajuste: a última vez que a IA mexeu nesta estação.
CREATE INDEX IF NOT EXISTS idx_suggestions_auto
  ON suggestions (station_id, created_at DESC)
  WHERE auto_aplicada = true;

-- -------------------------------------------------------------- stations
-- ia_autoajuste: deixa o usuário desligar o ajuste automático por estação,
-- continuando a receber as sugestões para aplicar à mão.
ALTER TABLE stations ADD COLUMN IF NOT EXISTS ia_autoajuste BOOLEAN NOT NULL DEFAULT true;

-- rotina_avaliada_em: quando a IA avaliou a rotina desta estação pela última
-- vez. Evita gastar chamada de API a cada salvamento repetido.
ALTER TABLE stations ADD COLUMN IF NOT EXISTS rotina_avaliada_em TIMESTAMPTZ;

COMMIT;
