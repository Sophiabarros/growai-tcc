// Última telemetria de cada estação, em memória.
//
// O banco guarda no máximo uma leitura por minuto (ver deviceController), o
// que é ótimo para histórico e péssimo para o painel de controle: depois de
// um "ligar ventilação", o app ficaria até 1 min mostrando o relé desligado.
// A placa fala a cada 5-15 s, e é isso que fica aqui.
//
// Uma instância só no Render, então um Map basta. Se o processo reiniciar,
// some tudo e a próxima telemetria (em segundos) repõe; enquanto isso o app
// cai na leitura do banco.

const ultimas = new Map();

function registrar(stationId, dados) {
  ultimas.set(Number(stationId), { ...dados, recebida_em: new Date().toISOString() });
}

function obter(stationId) {
  return ultimas.get(Number(stationId)) || null;
}

module.exports = { registrar, obter };
