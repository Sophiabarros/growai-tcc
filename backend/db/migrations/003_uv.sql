-- GrowAI - migração 003: luz UV no relé dos ventiladores
--
-- A luz UV foi instalada no MESMO relé da ventilação: ventilador ligado = UV
-- ligado. uv_min_dia é o orçamento diário de UV (minutos); o firmware
-- (main-1.2.0) limita a ventilação programada a ele e a mantém dentro do
-- fotoperíodo. 30 min é um começo conservador: estudos com ervas medicinais
-- mostram ganho de compostos de defesa com exposições curtas, e dano com
-- doses altas. Idempotente, como as anteriores.

BEGIN;

ALTER TABLE stations ADD COLUMN IF NOT EXISTS uv_min_dia INTEGER NOT NULL DEFAULT 30;

ALTER TABLE stations DROP CONSTRAINT IF EXISTS stations_uv_min_dia_check;
ALTER TABLE stations ADD CONSTRAINT stations_uv_min_dia_check
  CHECK (uv_min_dia BETWEEN 0 AND 240);

COMMIT;
