// Temperatura atual de São Paulo, da internet (Open-Meteo: grátis, sem chave).
//
// Usada só quando o sensor da placa (DS18B20) não tem leitura: o app mostra
// esta temperatura no lugar, marcada como "São Paulo (internet)", e o aviso de
// sensor com defeito continua aparecendo. É a temperatura do ar da cidade,
// não a de dentro da estufa — serve de referência, não de medição.
//
// Cache de 15 min: o Open-Meteo atualiza a cada 15 min, e o painel do app
// pede a leitura a cada poucos segundos.

const URL_SP =
  "https://api.open-meteo.com/v1/forecast?latitude=-23.55&longitude=-46.63&current=temperature_2m&timezone=America%2FSao_Paulo";
const CACHE_MS = 15 * 60 * 1000;

let cache = null; // { temperatura, em }
let buscando = null;

async function buscar() {
  const res = await fetch(URL_SP, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const j = await res.json();
  const t = Number(j && j.current && j.current.temperature_2m);
  if (!Number.isFinite(t)) throw new Error("Open-Meteo sem temperature_2m");
  cache = { temperatura: t, em: Date.now() };
  return cache;
}

/* Devolve { temperatura, em } ou null. Nunca lança: sem internet, a tela só
   fica com "—", como antes. Uma busca por vez, mesmo com vários pedidos. */
async function temperaturaSaoPaulo() {
  if (cache && Date.now() - cache.em < CACHE_MS) return cache;
  if (!buscando) {
    buscando = buscar()
      .catch((err) => {
        console.warn("[temperatura] São Paulo indisponível:", err.message);
        return cache; // o valor antigo é melhor que nada
      })
      .finally(() => {
        buscando = null;
      });
  }
  return buscando;
}

/* Versão que não espera: devolve o que já está em cache (até 1 h de idade) e,
   se estiver velho, dispara a atualização para a próxima vez. É a usada na
   telemetria, que responde à placa e não pode esperar a internet. */
function temperaturaSaoPauloJa() {
  if (!cache || Date.now() - cache.em >= CACHE_MS) temperaturaSaoPaulo();
  return cache && Date.now() - cache.em < 60 * 60 * 1000 ? cache : null;
}

/* Preenche a temperatura de uma leitura sem sensor. Marca a origem para o app
   escrever "São Paulo (internet)" e manter o aviso do sensor. */
function completarTemperatura(leitura, externa) {
  if (!leitura || (leitura.temperature !== null && leitura.temperature !== undefined)) return leitura;
  if (!externa) return leitura;
  return { ...leitura, temperature: externa.temperatura, temperatura_fonte: "sao_paulo" };
}

module.exports = { temperaturaSaoPaulo, temperaturaSaoPauloJa, completarTemperatura };
