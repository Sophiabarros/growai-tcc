const db = require("../config/db");
const { sanearEntrada, incrementarVersao, CAMPOS_DE_CONFIG } = require("../services/configDispositivo");
const autoAjuste = require("../services/autoAjuste");

async function list(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT sg.*, st.name AS station_name, st.plant
       FROM suggestions sg
       JOIN stations st ON st.id = sg.station_id
       WHERE st.user_id = $1
       ORDER BY sg.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/* Aplicar uma sugestão faz três coisas que precisam acontecer juntas ou não
   acontecer: marca como aplicada, grava o config novo na estação e sobe
   cfg_versao. Tudo numa transação — se a versão não subisse, a placa
   continuaria com a config antiga e o usuário veria "aplicada" sem efeito
   nenhum na horta.

   A sugestão vem da IA, então o config passa pelo mesmo saneamento de uma
   edição feita à mão: valor fora do limite é cortado, não aceito. */
async function apply(req, res, next) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: achadas } = await client.query(
      `SELECT sg.*
         FROM suggestions sg
         JOIN stations st ON st.id = sg.station_id
        WHERE sg.id = $1 AND st.user_id = $2
        FOR UPDATE OF sg`,
      [req.params.id, req.user.id]
    );
    const sugestao = achadas[0];
    if (!sugestao) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Sugestão não encontrada" });
    }

    let station = null;
    const avisos = [];

    if (sugestao.config && typeof sugestao.config === "object") {
      const { valores, erros } = sanearEntrada(sugestao.config);
      avisos.push(...erros);

      if (Object.keys(valores).length) {
        const { rows: antes } = await client.query("SELECT * FROM stations WHERE id = $1 FOR UPDATE", [
          sugestao.station_id,
        ]);

        const colunas = Object.keys(valores);
        const sets = colunas.map((c, i) => `${c} = $${i + 1}`).join(", ");
        const params = [...colunas.map((c) => valores[c]), sugestao.station_id];

        const { rows: depois } = await client.query(
          `UPDATE stations SET ${sets} WHERE id = $${colunas.length + 1} RETURNING *`,
          params
        );
        station = depois[0];

        const mudou = CAMPOS_DE_CONFIG.some(
          (c) => valores[c] !== undefined && String(antes[0][c]) !== String(station[c])
        );
        if (mudou) {
          const versao = await incrementarVersao(sugestao.station_id, client);
          station = { ...station, cfg_versao: versao };
        }
      }
    }

    const { rows: finais } = await client.query(
      "UPDATE suggestions SET applied = true WHERE id = $1 RETURNING *",
      [req.params.id]
    );

    await client.query("COMMIT");

    const resposta = { ...finais[0] };
    if (station) resposta.station = station;
    if (avisos.length) resposta.avisos = avisos;
    res.json(resposta);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
}

/* PATCH /suggestions/:id/undo
   Desfaz um ajuste que a IA aplicou sozinha: devolve os valores de
   config_anterior e sobe cfg_versao, para a placa receber a config de volta. */
async function undo(req, res, next) {
  try {
    const r = await autoAjuste.desfazer({ sugestaoId: req.params.id, userId: req.user.id });
    if (!r.ok) return res.status(r.status || 400).json({ error: r.erro });
    res.json({ ...r.sugestao, station: r.station });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, apply, undo };
