-- GrowAI - migração 006: avaliação da iluminação pela IA
--
-- A foto da IA é tirada com a luz de cultivo APAGADA e com flash (cores
-- reais), então não diz nada sobre a luz que a planta recebe. A CAM
-- (cam-2.1.0) tira, ~20 s antes, um quadro SEM flash, com a luz de cultivo
-- acesa e exposição travada: quanto mais escuro, menos luz. O quadro vai na
-- MESMA chamada da IA da foto seguinte, que devolve pouca/boa/muita.
--
-- Idempotente, como as anteriores.

BEGIN;

-- Só o último quadro de luz de cada estação (é usado e substituído a cada
-- 30 min; não há por que guardar histórico de imagem).
CREATE TABLE IF NOT EXISTS luz_frames (
  station_id   INTEGER PRIMARY KEY REFERENCES stations(id) ON DELETE CASCADE,
  image_url    TEXT        NOT NULL,
  captured_at  TIMESTAMPTZ NOT NULL
);

-- O veredito vai junto da análise da foto.
ALTER TABLE station_photos ADD COLUMN IF NOT EXISTS luz_nivel TEXT;
ALTER TABLE station_photos DROP CONSTRAINT IF EXISTS station_photos_luz_nivel_check;
ALTER TABLE station_photos ADD CONSTRAINT station_photos_luz_nivel_check
  CHECK (luz_nivel IS NULL OR luz_nivel IN ('pouca', 'boa', 'muita', 'incerto'));
ALTER TABLE station_photos ADD COLUMN IF NOT EXISTS luz_descricao TEXT;

COMMIT;
