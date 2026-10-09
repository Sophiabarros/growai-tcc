// Grava a sugestão da IA e, quando cabe, já aplica na estação.
//
// Tudo numa transação: ou a sugestão é gravada E a config aplicada E a versão
// sobe, ou nada acontece. Se a versão não subisse, a placa continuaria com a
// config antiga e o usuário veria "ajustado" sem efeito nenhum na horta.
//
// Três travas, nesta ordem:
//   1. estação com ia_autoajuste = false -> só sugere, não aplica;
//   2. cooldown -> a IA não mexe na mesma estação duas vezes em poucas horas
//      (só para a análise de FOTO; ver abaixo);
//   3. nada para mudar -> a sugestão é só um recado, não há o que aplicar.
// Quando uma trava impede o auto-ajuste, a sugestão AINDA é gravada, só com
// auto_aplicada = false: o usuário continua podendo aplicar no botão.
//
// Segurança física não depende daqui: o limite de 50 s de bomba e de 30 s de
// nutriente por dia está no firmware. O pior que um ajuste errado faz é a
// planta receber mais ou menos água do que devia, nunca afogar.

const db = require("../config/db");
const { sanearEntrada, incrementarVersao, CAMPOS_DE_CONFIG } = require("./configDispositivo");

// A IA não remexe na mesma estação antes disso. Sem a trava, uma foto a cada
// 30 min poderia virar 48 mudanças de rotina por dia, e a planta nunca
// estabilizaria em nada.
const COOLDOWN_H = Number(process.env.IA_AUTOAJUSTE_COOLDOWN_H || 6);

async function autoAjusteNoCooldown(stationId, client) {
  const { rows } = await client.query(
    `SELECT created_at FROM suggestions
      WHERE station_id = $1 AND auto_aplicada = true AND desfeita_em IS NULL
        AND created_at > now() - ($2 || ' hours')::interval
      ORDER BY created_at DESC LIMIT 1`,
    [stationId, String(COOLDOWN_H)]
  );
  return rows[0] || null;
}

/* Grava a sugestão e tenta aplicá-la.
   sugestao: o objeto já validado por services/ia.js
             ({ message, growth_pct, health_pct, config? })
   origem:   'ia_foto' ou 'ia_rotina'
   Devolve { sugestao, aplicada, motivo, station } */
async function registrar({ stationId, sugestao, origem }) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: estacoes } = await client.query("SELECT * FROM stations WHERE id = $1 FOR UPDATE", [stationId]);
    const estacao = estacoes[0];
    if (!estacao) {
      await client.query("ROLLBACK");
      return { sugestao: null, aplicada: false, motivo: "estação não existe" };
    }

    // O que dá para aplicar, depois de cortar para os limites. Campo que a IA
    // devolveu com o valor que a estação JÁ tem não é mudança: sem tirar,
    // o card mostrava "rega a cada: 9 -> 9".
    const { valores } = sanearEntrada(sugestao.config || {});
    for (const campo of Object.keys(valores)) {
      const atual = estacao[campo];
      const igual =
        campo === "luz_inicio" || campo === "nutri_hora"
          ? String(atual).slice(0, 5) === String(valores[campo]).slice(0, 5)
          : atual !== null && atual !== undefined && Number(atual) === Number(valores[campo]);
      if (igual) delete valores[campo];
    }
    const temOqueAplicar = Object.keys(valores).length > 0;

    let motivo = null;
    if (!temOqueAplicar) motivo = "a IA não propôs mudança de parâmetro";
    else if (!estacao.ia_autoajuste) motivo = "ajuste automático desligado nesta estação";
    /* O cooldown existe para a foto, que chega sozinha a cada 30 min. A
       avaliação de rotina só acontece quando o usuário SALVA uma rotina nova:
       é uma pessoa pedindo para a IA olhar o que acabou de digitar. Barrar por
       um ajuste de horas atrás deixaria uma rotina absurda passar sem correção. */
    else if (origem !== "ia_rotina") {
      const recente = await autoAjusteNoCooldown(stationId, client);
      if (recente) {
        const horas = ((Date.now() - new Date(recente.created_at).getTime()) / 3600000).toFixed(1);
        motivo = `a IA já ajustou esta estação há ${horas} h (cooldown de ${COOLDOWN_H} h)`;
      }
    }

    const vaiAplicar = motivo === null;

    // Os valores de ANTES, só dos campos que vão mudar. É o que o desfazer usa.
    const anterior = {};
    if (temOqueAplicar) {
      for (const campo of Object.keys(valores)) {
        let v = estacao[campo];
        // TIME vem como "06:00:00" do pg; NUMERIC vem como string.
        if (campo === "luz_inicio" || campo === "nutri_hora") v = String(v).slice(0, 5);
        else if (v !== null && v !== undefined) v = Number(v);
        anterior[campo] = v;
      }
    }

    const { rows: criadas } = await client.query(
      `INSERT INTO suggestions
         (station_id, message, growth_pct, health_pct, config, config_anterior, origem, applied, auto_aplicada)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       RETURNING *`,
      [
        stationId,
        sugestao.message,
        sugestao.growth_pct,
        sugestao.health_pct,
        temOqueAplicar ? JSON.stringify(valores) : null,
        temOqueAplicar ? JSON.stringify(anterior) : null,
        origem,
        vaiAplicar,
      ]
    );
    let nova = criadas[0];
    let station = estacao;

    if (vaiAplicar) {
      const colunas = Object.keys(valores);
      const sets = colunas.map((c, i) => `${c} = $${i + 1}`).join(", ");
      const { rows: depois } = await client.query(
        `UPDATE stations SET ${sets} WHERE id = $${colunas.length + 1} RETURNING *`,
        [...colunas.map((c) => valores[c]), stationId]
      );
      station = depois[0];

      const mudou = CAMPOS_DE_CONFIG.some((c) => valores[c] !== undefined && String(estacao[c]) !== String(station[c]));
      if (mudou) {
        const versao = await incrementarVersao(stationId, client);
        station = { ...station, cfg_versao: versao };
      }
    }

    await client.query("COMMIT");
    return { sugestao: nova, aplicada: vaiAplicar, motivo, station };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* Desfaz um ajuste que a IA aplicou: devolve os valores de config_anterior e
   sobe a versão de novo, para a placa receber a config de volta.
   Devolve { ok, erro?, sugestao?, station? } */
async function desfazer({ sugestaoId, userId }) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT sg.* FROM suggestions sg
         JOIN stations st ON st.id = sg.station_id
        WHERE sg.id = $1 AND st.user_id = $2
        FOR UPDATE OF sg`,
      [sugestaoId, userId]
    );
    const sg = rows[0];
    if (!sg) {
      await client.query("ROLLBACK");
      return { ok: false, erro: "Sugestão não encontrada", status: 404 };
    }
    if (!sg.auto_aplicada) {
      await client.query("ROLLBACK");
      return { ok: false, erro: "Esta sugestão não foi aplicada automaticamente", status: 400 };
    }
    if (sg.desfeita_em) {
      await client.query("ROLLBACK");
      return { ok: false, erro: "Este ajuste já foi desfeito", status: 400 };
    }
    if (!sg.config_anterior || !Object.keys(sg.config_anterior).length) {
      await client.query("ROLLBACK");
      return { ok: false, erro: "Não há valores anteriores guardados para desfazer", status: 400 };
    }

    // Passa pelo mesmo saneamento: o que foi gravado antes pode ter vindo de
    // uma versão anterior dos limites.
    const { valores } = sanearEntrada(sg.config_anterior);
    if (!Object.keys(valores).length) {
      await client.query("ROLLBACK");
      return { ok: false, erro: "Os valores anteriores não são mais válidos", status: 400 };
    }

    const colunas = Object.keys(valores);
    const sets = colunas.map((c, i) => `${c} = $${i + 1}`).join(", ");
    const { rows: depois } = await client.query(
      `UPDATE stations SET ${sets} WHERE id = $${colunas.length + 1} RETURNING *`,
      [...colunas.map((c) => valores[c]), sg.station_id]
    );
    const versao = await incrementarVersao(sg.station_id, client);
    const station = { ...depois[0], cfg_versao: versao };

    const { rows: finais } = await client.query(
      `UPDATE suggestions SET desfeita_em = now(), applied = false WHERE id = $1 RETURNING *`,
      [sugestaoId]
    );

    await client.query("COMMIT");
    return { ok: true, sugestao: finais[0], station };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { registrar, desfazer, COOLDOWN_H };
