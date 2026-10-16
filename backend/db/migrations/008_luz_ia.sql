-- GrowAI - migração 008: luz de cultivo decidida pela IA
--
-- O quadro de luz (cam-2.1.0) agora é tirado com o LED Grow APAGADO
-- (main-1.5.0): mede só a luz natural. Na análise da foto, a IA diz
-- pouca/boa/muita. Pouca: o LED segue a rotina (acende). Boa ou muita: o LED
-- fica apagado até luz_ia_ate (a próxima avaliação, com folga). O servidor
-- manda o tempo restante em toda resposta de telemetria (luz_pausa_s).
--
-- Idempotente, como as anteriores.

BEGIN;

ALTER TABLE stations ADD COLUMN IF NOT EXISTS luz_ia_ate TIMESTAMPTZ;
ALTER TABLE stations ADD COLUMN IF NOT EXISTS luz_ia_motivo TEXT;

COMMIT;
