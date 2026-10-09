const db = require("../config/db");
const { generateReading } = require("../services/mockSensor");
const { sanearEntrada, incrementarVersao, CAMPOS_DE_CONFIG } = require("../services/configDispositivo");
const { ONLINE_S } = require("./commandsController");
const { montarConfig } = require("../services/configDispositivo");
const { avaliarRotina: iaAvaliarRotina } = require("../services/ia");
const autoAjuste = require("../services/autoAjuste");

async function list(req, res, next) {
  try {
    const { rows } = await db.query(
      "SELECT * FROM stations WHERE user_id = $1 ORDER BY created_at",
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const { rows } = await db.query(
      "SELECT * FROM stations WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Estação não encontrada" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const { name, plant, tag, water_interval_h, light_hours, humidity_target, ph_target } = req.body;
    if (!name || !plant) {
      return res.status(400).json({ error: "Nome e planta são obrigatórios" });
    }

    const { rows } = await db.query(
      `INSERT INTO stations (user_id, name, plant, tag, water_interval_h, light_hours, humidity_target, ph_target)
       VALUES ($1, $2, $3, $4,
               COALESCE($5, 8), COALESCE($6, 12), COALESCE($7, 70), COALESCE($8, 6.5))
       RETURNING *`,
      [req.user.id, name, plant, tag, water_interval_h, light_hours, humidity_target, ph_target]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
}

/* Alem dos campos antigos, aceita a config do firmware que o app ainda nao
   edita em tela. Se algum campo que o firmware usa mudar de valor, sobe
   cfg_versao na MESMA transacao: a proxima telemetria da placa ja leva a
   config nova. Sem isso a placa continuaria com a config velha para sempre. */
async function update(req, res, next) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: atuais } = await client.query(
      "SELECT * FROM stations WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [req.params.id, req.user.id]
    );
    const atual = atuais[0];
    if (!atual) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Estação não encontrada" });
    }

    const { valores, erros } = sanearEntrada(req.body || {});

    // water_interval_h e ph_target também vêm de sanearEntrada (com limite),
    // mas não estão em CAMPOS_DE_CONFIG: o firmware não usa nenhum dos dois,
    // então mudá-los não sobe cfg_versao.

    /* name, plant e tag.
       Estes NÃO eram aceitos aqui, e o modal de estações sempre os enviou:
       editar o nome ou a planta parecia funcionar (o modal fechava sem erro),
       mas o backend descartava o campo e a tela voltava a mostrar o valor
       antigo. Era o motivo de "não consigo editar o nome".

       Não mexem em cfg_versao: o firmware não sabe o nome da planta. Mas a IA
       sabe — a avaliação de rotina julga a rotina contra a espécie e a
       finalidade —, então trocar plant ou tag invalida a avaliação anterior
       (ver rotina_avaliada_em logo abaixo). */
    const corpo = req.body || {};
    const texto = {};

    if (corpo.name !== undefined) {
      const v = String(corpo.name).trim();
      if (!v) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "O nome não pode ficar vazio" });
      }
      if (v.length > 80) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "O nome pode ter no máximo 80 caracteres" });
      }
      texto.name = v;
    }

    if (corpo.plant !== undefined) {
      const v = String(corpo.plant).trim();
      if (!v) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "A planta não pode ficar vazia" });
      }
      if (v.length > 80) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "A planta pode ter no máximo 80 caracteres" });
      }
      texto.plant = v;
    }

    // tag é opcional: vazio ou null limpa o campo (o modal manda `|| null`).
    if ("tag" in corpo) {
      const v = corpo.tag === null ? null : String(corpo.tag).trim();
      if (v !== null && v.length > 80) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "A finalidade pode ter no máximo 80 caracteres" });
      }
      texto.tag = v === "" ? null : v;
    }

    const novos = { ...valores, ...texto };
    if (!Object.keys(novos).length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Nenhum campo válido para atualizar", detalhes: erros });
    }

    const colunas = Object.keys(novos);
    const sets = colunas.map((c, i) => `${c} = $${i + 1}`).join(", ");
    const params = colunas.map((c) => novos[c]);
    params.push(req.params.id, req.user.id);

    const { rows } = await client.query(
      `UPDATE stations SET ${sets}
        WHERE id = $${colunas.length + 1} AND user_id = $${colunas.length + 2}
        RETURNING *`,
      params
    );
    let station = rows[0];

    // Comparação como string: o pg devolve NUMERIC como string e TIME como
    // "06:00:00", então == direto daria falso positivo.
    const mudouConfig = CAMPOS_DE_CONFIG.some(
      (c) => novos[c] !== undefined && String(atual[c]) !== String(station[c])
    );
    if (mudouConfig) {
      const versao = await incrementarVersao(req.params.id, client);
      station = { ...station, cfg_versao: versao };
    }

    /* Mudou a espécie ou a finalidade? A avaliação de rotina anterior foi
       feita para OUTRA planta, então não vale mais. Zerar rotina_avaliada_em
       tira o cooldown para a próxima avaliação sair na hora. */
    const mudouPlanta =
      (texto.plant !== undefined && String(atual.plant) !== String(station.plant)) ||
      (texto.tag !== undefined && String(atual.tag) !== String(station.tag));
    if (mudouPlanta) {
      await client.query("UPDATE stations SET rotina_avaliada_em = NULL WHERE id = $1", [req.params.id]);
      station.rotina_avaliada_em = null;
    }

    await client.query("COMMIT");
    res.json(erros.length ? { ...station, avisos: erros } : station);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
}

async function remove(req, res, next) {
  try {
    const { rowCount } = await db.query(
      "DELETE FROM stations WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: "Estação não encontrada" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

/* Ultima leitura REAL gravada por POST /api/device/telemetria.
   Mantem o formato antigo (humidity, ph, light_h, temperature, recorded_at) e
   acrescenta `online` e `reles`.

   humidity/temperature podem vir null (sensor com defeito) e ph e SEMPRE null:
   o projeto nao tem sensor de pH. O front mostra "—" nesses casos.

   MOCK_SENSOR=1 volta a gerar leitura simulada, para mexer no layout do app
   sem placa ligada. */
async function getLatestReading(req, res, next) {
  try {
    const { rows } = await db.query(
      "SELECT * FROM stations WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    const station = rows[0];
    if (!station) return res.status(404).json({ error: "Estação não encontrada" });

    if (process.env.MOCK_SENSOR === "1") {
      return res.json({
        ...generateReading(station),
        reles: null,
        online: true,
        mock: true,
        recorded_at: new Date().toISOString(),
      });
    }

    const { rows: leituras } = await db.query(
      "SELECT * FROM sensor_readings WHERE station_id = $1 ORDER BY recorded_at DESC LIMIT 1",
      [req.params.id]
    );
    const leitura = leituras[0];
    if (!leitura) return res.status(404).json({ error: "Nenhuma leitura registrada ainda" });

    // online = a placa 'main' falou com o servidor nos ultimos 60 s. Nao se
    // deduz de recorded_at, que e limitado a uma gravacao por minuto.
    const { rows: vistas } = await db.query(
      `SELECT (max(last_seen) > now() - ($2 || ' seconds')::interval) AS online
         FROM devices WHERE station_id = $1 AND tipo = 'main'`,
      [req.params.id, String(ONLINE_S)]
    );

    const n = (v) => (v === null || v === undefined ? null : Number(v));
    res.json({
      humidity: n(leitura.humidity),
      ph: n(leitura.ph),
      light_h: n(leitura.light_h),
      temperature: n(leitura.temperature),
      estado: leitura.estado,
      reles: leitura.reles,
      online: !!(vistas[0] && vistas[0].online),
      recorded_at: leitura.recorded_at,
    });
  } catch (err) {
    next(err);
  }
}

// Última foto/status de saúde da estação (tela Câmera).
async function getLatestPhoto(req, res, next) {
  try {
    const { rows: stationRows } = await db.query(
      "SELECT id FROM stations WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    if (!stationRows[0]) return res.status(404).json({ error: "Estação não encontrada" });

    /* Prefere a ultima foto ANALISADA, nao a ultima foto.
       A CAM manda foto a cada 30 min, mas a analise e espacada para caber na
       cota da API (ver IA_FOTO_INTERVALO_MIN), entao a foto mais recente
       geralmente nao tem diagnostico. Mostrar essa deixaria a tela Camera
       quase sempre em "Sem analise", com a analise boa escondida no historico.
       Sem nenhuma analisada (IA desligada, ou recem-instalado), cai para a
       mais recente mesmo. */
    const { rows } = await db.query(
      `SELECT * FROM station_photos
        WHERE station_id = $1
        ORDER BY (health_status <> 'indefinido') DESC, captured_at DESC
        LIMIT 1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Nenhuma foto registrada ainda" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}


/* POST /stations/:id/avaliar-rotina
   Pergunta a IA se a rotina configurada faz sentido para a especie e a
   finalidade (o campo `tag`) da estacao. NAO manda foto: julga so os numeros,
   entao e mais rapida e barata que a analise de imagem.

   Chamada pelo app depois de salvar a rotina, sem travar o salvamento (ver
   js/station-modal.js). Se a IA achar que esta errado, o autoAjuste grava a
   sugestao e, quando permitido, ja corrige a estacao.

   Tem cooldown proprio: salvar a rotina cinco vezes seguidas nao gasta cinco
   chamadas de API. */
const AVALIA_ROTINA_COOLDOWN_MIN = Number(process.env.IA_ROTINA_COOLDOWN_MIN || 2);

async function avaliarRotina(req, res, next) {
  try {
    const { rows } = await db.query("SELECT * FROM stations WHERE id = $1 AND user_id = $2", [
      req.params.id,
      req.user.id,
    ]);
    const station = rows[0];
    if (!station) return res.status(404).json({ error: "Estação não encontrada" });

    if (station.rotina_avaliada_em) {
      const minutos = (Date.now() - new Date(station.rotina_avaliada_em).getTime()) / 60000;
      if (minutos < AVALIA_ROTINA_COOLDOWN_MIN && req.query.forcar !== "1") {
        return res.json({
          avaliado: false,
          motivo: `avaliada há ${minutos.toFixed(1)} min (cooldown de ${AVALIA_ROTINA_COOLDOWN_MIN} min)`,
        });
      }
    }

    const { rows: leituras } = await db.query(
      "SELECT * FROM sensor_readings WHERE station_id = $1 ORDER BY recorded_at DESC LIMIT 1",
      [req.params.id]
    );

    const r = await iaAvaliarRotina({
      estacao: station,
      leitura: leituras[0] || null,
      config: montarConfig(station),
    });

    // Marca a tentativa mesmo se a IA falhou, senao um erro de rede faria o app
    // tentar de novo a cada salvamento.
    await db.query("UPDATE stations SET rotina_avaliada_em = now() WHERE id = $1", [req.params.id]);

    if (!r.ok) {
      console.warn(`[rotina] estação ${station.id}: IA não avaliou — ${r.motivo}`);
      return res.json({ avaliado: false, motivo: r.motivo });
    }

    const resposta = {
      avaliado: true,
      health_status: r.health_status,
      analysis_text: r.analysis_text,
      sugestao: null,
      aplicada: false,
    };

    if (r.suggestion) {
      const reg = await autoAjuste.registrar({
        stationId: station.id,
        sugestao: r.suggestion,
        origem: "ia_rotina",
      });
      resposta.sugestao = reg.sugestao;
      resposta.aplicada = reg.aplicada;
      if (reg.motivo) resposta.motivo = reg.motivo;
      if (reg.station) resposta.station = reg.station;
    }

    res.json(resposta);
  } catch (err) {
    next(err);
  }
}

module.exports = { list, getOne, create, update, remove, getLatestReading, getLatestPhoto, avaliarRotina };
