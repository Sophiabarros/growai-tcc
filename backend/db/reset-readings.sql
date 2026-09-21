-- GrowAI (TrackLink) - zera o relatório semanal
--
-- Apaga as leituras de sensor gravadas até hoje. Até o ESP32 enviar dados
-- reais, todas elas vieram da simulação (services/mockSensor.js), e o
-- relatório semanal (GET /api/reports/weekly) só lê esta tabela.
--
-- NÃO roda sozinho: cole no SQL Editor do Neon (ou use psql) quando quiser
-- zerar os gráficos.

DELETE FROM sensor_readings;
