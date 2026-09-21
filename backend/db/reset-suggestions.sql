-- GrowAI (TrackLink) - zera as sugestões de otimização
--
-- Apaga as sugestões que já estão no banco. Todas vieram do seed de
-- demonstração (db/seed.sql); não existe nenhum código que gere sugestões
-- reais ainda. A tela Relatórios passa a mostrar "Nenhuma sugestão por
-- enquanto.".
--
-- NÃO roda sozinho: cole no SQL Editor do Neon (ou use psql) quando quiser
-- zerar.

DELETE FROM suggestions;
