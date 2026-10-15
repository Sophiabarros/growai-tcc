// Resumo diário dos relatórios (tabela relatorio_diario, migração 004).
//
// Por que guardar resumo em vez de calcular na hora: as fotos são apagadas
// depois de ~300 por estação (uns 6 dias) e as leituras brutas ficam só
// RETENCAO_LEITURAS_DIAS. O resumo de cada dia fica para sempre, então o
// gráfico da semana (ou de um mês, no futuro) continua existindo mesmo
// depois que os dados brutos somem.
//
// Quem chama:
//   - agendador (iniciar): a cada 10 min refaz hoje e ontem de todas as
//     estações e apaga leituras brutas velhas;
//   - deviceController.analisarFoto: refaz o dia assim que uma foto é
//     analisada, para a saúde aparecer na hora;
//   - reportsController: refaz o dia de hoje antes de responder.

const db = require("../config/db");

const TZ = "America/Sao_Paulo";
const RETENCAO_LEITURAS_DIAS = 30;
const INTERVALO_MS = 10 * 60 * 1000;

/* Recalcula o resumo de UM dia (data "YYYY-MM-DD" no fuso de São Paulo) de
   uma estação, a partir das tabelas brutas, e grava. Idempotente: rodar de
   novo só atualiza. Dia sem nada bruto não cria linha. */
async function atualizarResumo(stationId, dia) {
  await db.query(
    `WITH
       leit AS (
         SELECT count(*)::int                         AS leituras,
                round(avg(humidity), 1)               AS umidade_media,
                min(humidity)                         AS umidade_min,
                max(humidity)                         AS umidade_max,
                round(avg(temperature), 1)            AS temp_media,
                min(temperature)                      AS temp_min,
                max(temperature)                      AS temp_max,
                max((extra->'hoje_s'->>'luz')::int)   AS luz_s,
                max((extra->'hoje_s'->>'vent')::int)  AS uv_s,
                max((extra->'hoje_s'->>'bomba')::int) AS bomba_s,
                max((extra->'hoje_s'->>'nutri')::int) AS nutri_s
           FROM sensor_readings
          WHERE station_id = $1
            AND (recorded_at AT TIME ZONE $3)::date = $2::date
       ),
       fot AS (
         SELECT count(*) FILTER (WHERE health_status <> 'indefinido')::int AS analisadas,
                count(*) FILTER (WHERE health_status = 'saudavel')::int    AS saudaveis,
                count(*) FILTER (WHERE health_status = 'atencao')::int     AS atencao
           FROM station_photos
          WHERE station_id = $1
            AND (captured_at AT TIME ZONE $3)::date = $2::date
       )
     INSERT INTO relatorio_diario AS r
       (station_id, dia, fotos_analisadas, fotos_saudaveis, fotos_atencao, saude_pct,
        leituras, umidade_media, umidade_min, umidade_max, temp_media, temp_min, temp_max,
        luz_s, uv_s, bomba_s, nutri_s, atualizado_em)
     SELECT $1, $2::date, fot.analisadas, fot.saudaveis, fot.atencao,
            CASE WHEN fot.analisadas > 0 THEN round(100.0 * fot.saudaveis / fot.analisadas)::int END,
            leit.leituras, leit.umidade_media, leit.umidade_min, leit.umidade_max,
            leit.temp_media, leit.temp_min, leit.temp_max,
            leit.luz_s, leit.uv_s, leit.bomba_s, leit.nutri_s, now()
       FROM leit, fot
      WHERE leit.leituras > 0 OR fot.analisadas > 0
     ON CONFLICT (station_id, dia) DO UPDATE SET
       /* Os dados brutos somem com o tempo (retenção). Se o recálculo de um
          dia antigo achar MENOS do que já estava guardado, fica o guardado. */
       fotos_analisadas = GREATEST(r.fotos_analisadas, EXCLUDED.fotos_analisadas),
       fotos_saudaveis  = CASE WHEN EXCLUDED.fotos_analisadas >= r.fotos_analisadas THEN EXCLUDED.fotos_saudaveis ELSE r.fotos_saudaveis END,
       fotos_atencao    = CASE WHEN EXCLUDED.fotos_analisadas >= r.fotos_analisadas THEN EXCLUDED.fotos_atencao ELSE r.fotos_atencao END,
       saude_pct        = CASE WHEN EXCLUDED.fotos_analisadas >= r.fotos_analisadas THEN EXCLUDED.saude_pct ELSE r.saude_pct END,
       leituras         = GREATEST(r.leituras, EXCLUDED.leituras),
       umidade_media    = CASE WHEN EXCLUDED.leituras >= r.leituras THEN EXCLUDED.umidade_media ELSE r.umidade_media END,
       umidade_min      = CASE WHEN EXCLUDED.leituras >= r.leituras THEN EXCLUDED.umidade_min ELSE r.umidade_min END,
       umidade_max      = CASE WHEN EXCLUDED.leituras >= r.leituras THEN EXCLUDED.umidade_max ELSE r.umidade_max END,
       temp_media       = CASE WHEN EXCLUDED.leituras >= r.leituras THEN EXCLUDED.temp_media ELSE r.temp_media END,
       temp_min         = CASE WHEN EXCLUDED.leituras >= r.leituras THEN EXCLUDED.temp_min ELSE r.temp_min END,
       temp_max         = CASE WHEN EXCLUDED.leituras >= r.leituras THEN EXCLUDED.temp_max ELSE r.temp_max END,
       luz_s            = GREATEST(r.luz_s, EXCLUDED.luz_s),
       uv_s             = GREATEST(r.uv_s, EXCLUDED.uv_s),
       bomba_s          = GREATEST(r.bomba_s, EXCLUDED.bomba_s),
       nutri_s          = GREATEST(r.nutri_s, EXCLUDED.nutri_s),
       atualizado_em    = now()`,
    [stationId, dia, TZ]
  );
}

// "YYYY-MM-DD" de hoje (ou de N dias atrás) no fuso de São Paulo.
function diaSP(diasAtras = 0) {
  const d = new Date(Date.now() - diasAtras * 86400000);
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

/* Refaz hoje e ontem de todas as estações (ontem porque leituras e fotos da
   virada do dia chegam com atraso), e na primeira rodada os últimos
   RETENCAO_LEITURAS_DIAS dias, para preencher o histórico que já existe. */
let primeiraRodada = true;
async function rodada() {
  const { rows: estacoes } = await db.query("SELECT id FROM stations");
  const dias = primeiraRodada
    ? Array.from({ length: RETENCAO_LEITURAS_DIAS }, (_, i) => diaSP(i))
    : [diaSP(0), diaSP(1)];
  for (const { id } of estacoes) {
    for (const dia of dias) await atualizarResumo(id, dia);
  }
  primeiraRodada = false;

  // Só depois do resumo: o que sai daqui já está guardado no relatorio_diario.
  const { rowCount } = await db.query(
    `DELETE FROM sensor_readings WHERE recorded_at < now() - ($1 || ' days')::interval`,
    [String(RETENCAO_LEITURAS_DIAS)]
  );
  if (rowCount) console.log(`[relatorios] ${rowCount} leituras com mais de ${RETENCAO_LEITURAS_DIAS} dias apagadas`);

  // Avisos de tempo: placa desconectada, relatório semanal pronto.
  await require("./notificacoes").rodada();
}

function iniciar() {
  const executar = () => rodada().catch((err) => console.error("[relatorios] rodada falhou:", err.message));
  setTimeout(executar, 15000).unref();          // deixa o servidor subir primeiro
  setInterval(executar, INTERVALO_MS).unref();
}

module.exports = { atualizarResumo, diaSP, iniciar, TZ, RETENCAO_LEITURAS_DIAS };
