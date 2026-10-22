// "Trocar a rede Wi-Fi" pedido pelo app para a placa PRINCIPAL.
//
// O servidor não consegue chamar a placa: o pedido fica aqui e vai na
// resposta da próxima telemetria (abrir_portal: true), que chega em 5-15 s.
// A placa esquece a rede e abre o portal GrowAI-setup (main-1.7.0).
//
// Em memória de propósito: é um pedido de segundos. Se o servidor reiniciar
// antes da placa falar, é só apertar o botão de novo. A câmera não passa por
// aqui: ela está no WebSocket e recebe o pedido na hora (realtime.js).

const PRAZO_MS = 10 * 60 * 1000; // pedido velho não vale: a pessoa já desistiu

const pendentes = new Map(); // stationId -> expira em (ms)

function pedir(stationId) {
  pendentes.set(Number(stationId), Date.now() + PRAZO_MS);
}

// Na telemetria: há pedido para esta estação? Se sim, entrega uma vez só.
function consumir(stationId) {
  const id = Number(stationId);
  const ate = pendentes.get(id);
  if (!ate) return false;
  pendentes.delete(id);
  return ate > Date.now();
}

function pendente(stationId) {
  const ate = pendentes.get(Number(stationId));
  return !!ate && ate > Date.now();
}

module.exports = { pedir, consumir, pendente };
