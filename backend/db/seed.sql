-- GrowAI (TrackLink) - dados de demonstração
-- Rode DEPOIS do schema.sql: npm run db:seed
-- Usuário de teste: demo@growai.com / senha123

INSERT INTO users (name, email, password_hash)
VALUES ('Usuária Demo', 'demo@growai.com', crypt('senha123', gen_salt('bf')))
ON CONFLICT (email) DO NOTHING;

-- Sem sugestões de exemplo: a tabela suggestions começa vazia (a tela
-- Relatórios mostra "Nenhuma sugestão por enquanto.") e só é preenchida por
-- sugestões reais.
INSERT INTO stations (user_id, name, plant, tag, water_interval_h, light_hours, humidity_target, ph_target)
SELECT id, 'Estação 1', 'Camomila', 'Anti-inflamatória', 8, 12, 75, 6.5 FROM users WHERE email = 'demo@growai.com'
UNION ALL
SELECT id, 'Estação 2', 'Hortelã', 'Calmante', 6, 10, 65, 6.0 FROM users WHERE email = 'demo@growai.com';

INSERT INTO notification_settings (user_id, health_alerts, watering_updates, weekly_reports)
SELECT id, true, true, false FROM users WHERE email = 'demo@growai.com'
ON CONFLICT (user_id) DO NOTHING;

-- Latest snapshot per station, used by the Home dashboard and Câmera page.
INSERT INTO station_photos (station_id, image_url, health_status, analysis_text, captured_at)
SELECT s.id, 'assets/images/app/img-app-camomila.png', 'saudavel',
       'Planta saudável, crescimento normal.', now() - interval '2 minutes'
FROM stations s WHERE s.name = 'Estação 1'
UNION ALL
SELECT s.id, 'assets/images/app/img-app-hortela.png', 'atencao',
       'Folhas com coloração levemente amarelada, possível deficiência de nitrogênio.', now() - interval '5 minutes'
FROM stations s WHERE s.name = 'Estação 2';
