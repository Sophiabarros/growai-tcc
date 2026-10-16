// Luz de cultivo decidida pela IA (migração 008, main-1.5.0).
//
// O quadro de luz da CAM é tirado com o LED Grow apagado: mostra só a luz
// natural. Quando a análise da foto traz o veredito:
//   pouca            -> LED segue a rotina (acende no fotoperíodo);
//   boa ou muita     -> LED apagado até a próxima avaliação (o sol basta);
//   incerto / nada   -> não muda nada.
// A pausa vale até luz_ia_ate = agora + intervalo de análise + folga. Se a
// próxima análise não vier (cota da IA, câmera fora), a pausa acaba sozinha e
// o LED volta para a rotina: a planta nunca fica sem luz por falta de IA.
// O tempo restante vai para a placa em toda telemetria (luz_pausa_s).

const db = require("../config/db");
const notificacoes = require("./notificacoes");

const IA_FOTO_INTERVALO_MIN = Number(process.env.IA_FOTO_INTERVALO_MIN || 180);
const FOLGA_MIN = 15;

function horaSP(data) {
  return data.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
}

// Segundos de LED apagado que a placa deve cumprir agora (0 = rotina).
function pausaSegundos(station) {
  if (!station || !station.luz_ia_ate) return 0;
  return Math.max(0, Math.round((new Date(station.luz_ia_ate).getTime() - Date.now()) / 1000));
}

async function decidir(station, r) {
  try {
    if (!station || !r || !r.ok) return;
    const nivel = r.luz_nivel;
    if (nivel !== "pouca" && nivel !== "boa" && nivel !== "muita") return;

    const { rows } = await db.query("SELECT luz_ia_ate FROM stations WHERE id = $1", [station.id]);
    const estavaPausada = pausaSegundos(rows[0]) > 0;
    const nome = station.name || station.plant || "estação";

    if (nivel === "pouca") {
      await db.query("UPDATE stations SET luz_ia_ate = NULL, luz_ia_motivo = $2 WHERE id = $1", [
        station.id,
        r.luz_descricao || "Pouca luz natural.",
      ]);
      if (estavaPausada) {
        await notificacoes.criar({
          userId: station.user_id, stationId: station.id, tipo: "luz", semRepetirMin: 0,
          titulo: `A IA acendeu a luz de cultivo de ${nome}`,
          mensagem: `Pouca luz natural${r.luz_descricao ? ": " + r.luz_descricao : "."} O LED volta a seguir a rotina.`,
        });
      }
      return;
    }

    const ate = new Date(Date.now() + (IA_FOTO_INTERVALO_MIN + FOLGA_MIN) * 60 * 1000);
    const motivo = r.luz_descricao || (nivel === "muita" ? "Luz natural forte." : "Luz natural boa.");
    await db.query("UPDATE stations SET luz_ia_ate = $2, luz_ia_motivo = $3 WHERE id = $1", [station.id, ate, motivo]);
    if (!estavaPausada) {
      await notificacoes.criar({
        userId: station.user_id, stationId: station.id, tipo: "luz", semRepetirMin: 0,
        titulo: `A IA apagou a luz de cultivo de ${nome}`,
        mensagem: `${nivel === "muita" ? "Luz natural forte" : "A luz natural está boa"}: ${motivo} ` +
          `O LED fica apagado até a próxima avaliação (por volta das ${horaSP(ate)}).`,
      });
    }
  } catch (err) {
    console.error("[luzIa] falha ao decidir:", err.message);
  }
}

module.exports = { decidir, pausaSegundos };
