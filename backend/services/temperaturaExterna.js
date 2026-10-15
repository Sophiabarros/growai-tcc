// Temperatura atual de São Paulo, da internet (Open-Meteo: grátis, sem chave).
//
// Usada só quando o sensor da placa (DS18B20) não tem leitura: o app mostra
// esta temperatura no lugar, marcada como "São Paulo (internet)", e o aviso de
// sensor com defeito continua aparecendo. É a temperatura do ar da cidade,
// não a de dentro da estufa — serve de referência, não de medição.
//
// Cache de 15 min: o Open-Meteo atualiza a cada 15 min, e o painel do app
// pede a leitura a cada poucos segundos.

const CACHE_MS = 15 * 60 * 1000;

/* Três fontes, tentadas em ordem. O Open-Meteo sozinho falhava no Render:
   ele limita IPs de nuvem compartilhados, e no servidor a temperatura voltava
   vazia (no computador local funcionava). Cada fonte devolve °C ou lança. */
const UA = "GrowAI-TCC/1.0 (+https://growai-xi.vercel.app)";
const FONTES = [
  {
    nome: "Open-Meteo",
    url: "https://api.open-meteo.com/v1/forecast?latitude=-23.55&longitude=-46.63&current=temperature_2m&timezone=America%2FSao_Paulo",
    ler: (j) => j.current.temperature_2m,
  },
  {
    // MET Norway exige um User-Agent que identifique o app.
    nome: "MET Norway",
    url: "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=-23.55&lon=-46.63",
    ler: (j) => j.properties.timeseries[0].data.instant.details.air_temperature,
  },
  {
    nome: "wttr.in",
    url: "https://wttr.in/Sao+Paulo?format=j1",
    ler: (j) => j.current_condition[0].temp_C,
  },
];

let cache = null; // { temperatura, em, fonte }
let buscando = null;
let ultimaFalha = null; // texto do último erro, para GET /api/health/clima

async function buscar() {
  const falhas = [];
  for (const f of FONTES) {
    try {
      const res = await fetch(f.url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const t = Number(f.ler(await res.json()));
      if (!Number.isFinite(t)) throw new Error("sem temperatura na resposta");
      cache = { temperatura: Math.round(t * 10) / 10, em: Date.now(), fonte: f.nome };
      if (falhas.length) console.warn(`[temperatura] ${f.nome} respondeu depois de: ${falhas.join(" | ")}`);
      return cache;
    } catch (err) {
      falhas.push(`${f.nome}: ${err.message}`);
    }
  }
  ultimaFalha = falhas.join(" | ");
  throw new Error(ultimaFalha);
}

// Estado para diagnóstico (GET /api/health/clima). Nada sensível aqui.
async function diagnostico() {
  const r = await temperaturaSaoPaulo();
  return { temperatura: r ? r.temperatura : null, fonte: r ? r.fonte : null,
           atualizada_em: r ? new Date(r.em).toISOString() : null, ultima_falha: ultimaFalha };
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

module.exports = { temperaturaSaoPaulo, temperaturaSaoPauloJa, completarTemperatura, diagnostico };
