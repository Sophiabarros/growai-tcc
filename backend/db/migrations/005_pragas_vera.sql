-- GrowAI - migração 005: anti-pragas na análise da foto e o chat da Vera
--
-- Idempotente, como as anteriores.

BEGIN;

-- ------------------------------------------------------------- pragas
-- A IA diz, em cada foto analisada, se vê praga: 'sim', 'nao' ou 'incerto'
-- (foto escura, desfocada, planta fora do quadro). NULL = foto analisada
-- antes desta migração ou não analisada.
ALTER TABLE station_photos ADD COLUMN IF NOT EXISTS pragas TEXT;
ALTER TABLE station_photos DROP CONSTRAINT IF EXISTS station_photos_pragas_check;
ALTER TABLE station_photos ADD CONSTRAINT station_photos_pragas_check
  CHECK (pragas IS NULL OR pragas IN ('sim', 'nao', 'incerto'));
-- Qual praga e onde, em uma frase ("pulgões no verso das folhas novas").
ALTER TABLE station_photos ADD COLUMN IF NOT EXISTS pragas_descricao TEXT;

-- --------------------------------------------------------------- Vera
-- Cada pergunta feita à Vera. Serve para o limite diário (3 por usuário por
-- dia, no fuso de São Paulo) e para mostrar a conversa do dia.
CREATE TABLE IF NOT EXISTS vera_perguntas (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pergunta    TEXT    NOT NULL,
  resposta    TEXT,
  ok          BOOLEAN NOT NULL DEFAULT false,  -- false = a IA falhou; não conta no limite
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vera_user_dia ON vera_perguntas (user_id, criado_em DESC);

COMMIT;
